#!/usr/bin/env python3
"""
MediaMTX RTSP 延迟转发管理器。

从 MEDIAMTX_CONFIG 指向的 mediamtx.yml 读取 paths，并自动为每个
存在延迟发布路径的摄像头创建独立的 GStreamer pipeline。

例如：

  camera1:
    source: rtsp://...

  camera1-5s:
    source: publisher

会自动生成：

  rtsp://127.0.0.1:8554/camera1 -> rtsp://127.0.0.1:8554/camera1-5s

视频和音频会一起延迟转发，每路流使用相同
延迟参数的 queue，保持音画同步。
"""

import os
import signal
import sys
import threading
import time

import gi
import yaml

gi.require_version("Gst", "1.0")
gi.require_version("GLib", "2.0")

from gi.repository import GLib, Gst

Gst.init(sys.argv)

MEDIAMTX_CONFIG = os.environ.get("MEDIAMTX_CONFIG", "/config/mediamtx.yml")
RTSP_BASE = os.environ.get("RTSP_BASE", "rtsp://127.0.0.1:8554")
DELAYED_SUFFIX = os.environ.get("DELAYED_SUFFIX", "-5s")
DELAY_NS = int(os.environ.get("DELAY_NS", "5000000000"))
RETRY_INTERVAL = int(os.environ.get("RETRY_INTERVAL", "30"))
STALL_TIMEOUT = int(os.environ.get("STALL_TIMEOUT", "30"))
CLEANUP_TIMEOUT = 15
if DELAY_NS < 0 or RETRY_INTERVAL <= 0 or STALL_TIMEOUT <= 0:
    raise ValueError("DELAY_NS must be >= 0; RETRY_INTERVAL and STALL_TIMEOUT must be > 0")

# 按 RTP caps 的 encoding-name 选择 depay/parse 链；rtspclientsink 会按
# 解析后的 caps 自动重新打包回 RTP。
STREAM_CHAINS = {
    "video": {
        "H264": ("rtph264depay", "h264parse"),
        "H265": ("rtph265depay", "h265parse"),
    },
    "audio": {
        "PCMA": ("rtppcmadepay", None),
        "PCMU": ("rtppcmudepay", None),
        "MP4A-LATM": ("rtpmp4gdepay", "aacparse"),
        "MPEG4-GENERIC": ("rtpmp4gdepay", "aacparse"),
        "OPUS": ("rtpopusdepay", "opusparse"),
    },
}


def load_cameras(config_path):
    # 从 mediamtx.yml 的 paths 自动识别需要延迟转发的摄像头。
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}

    paths = config.get("paths") or {}
    if not isinstance(paths, dict):
        raise ValueError("mediamtx.yml paths must be a mapping")

    cameras = []
    for name, path_config in paths.items():
        # 跳过 camera1-5s 这种延迟发布路径，只处理原始摄像头路径。
        if not isinstance(path_config, dict):
            continue
        if name.endswith(DELAYED_SUFFIX):
            continue

        delayed_name = f"{name}{DELAYED_SUFFIX}"
        delayed_config = paths.get(delayed_name)
        if not isinstance(delayed_config, dict):
            continue
        # 只有对应延迟路径是 publisher 时，才创建转发 pipeline。
        if delayed_config.get("source") != "publisher":
            continue

        cameras.append(
            {
                "name": name,
                "source": f"{RTSP_BASE}/{name}",
                "sink": f"{RTSP_BASE}/{delayed_name}",
            }
        )

    return cameras


class CameraPipeline:
    # 单路摄像头 pipeline，负责启动、停止和异常重连。
    def __init__(self, cam):
        self.name = cam["name"]
        self.source = cam["source"]
        self.sink = cam["sink"]
        self.pipeline = None
        self.rtspsrc = None
        self.client_sink = None
        self.bus = None
        self.bus_handler_id = None
        self.retry_timer_id = None
        self.running = False
        self.stopped = False
        self.watchdog_id = None
        self.cleanup_thread = None
        # 每路音视频流一项：{"media", "activity", "started_at"}。
        self.streams = []

    def build_pipeline(self):
        # rtspsrc 的音视频 pad 在协商出 SDP 后才出现，必须动态建链。
        self.pipeline = Gst.Pipeline.new(f"{self.name}-pipeline")

        self.rtspsrc = Gst.ElementFactory.make("rtspsrc", "source")
        self.rtspsrc.set_property("location", self.source)
        self.rtspsrc.set_property("protocols", Gst.RTSPLowerTrans.TCP)
        self.rtspsrc.set_property("latency", 0)
        self.rtspsrc.connect("pad-added", self.on_pad_added)

        self.client_sink = Gst.ElementFactory.make("rtspclientsink", "sink")
        self.client_sink.set_property("location", self.sink)
        self.client_sink.set_property("protocols", Gst.RTSPLowerTrans.TCP)

        self.pipeline.add(self.rtspsrc)
        self.pipeline.add(self.client_sink)

        self.bus = self.pipeline.get_bus()
        self.bus.add_signal_watch()
        self.bus_handler_id = self.bus.connect("message", self.bus_message)

    def on_pad_added(self, src, pad):
        # 运行在流线程中；为新出现的流挂接 depay -> parse -> queue 链。
        caps = pad.get_current_caps() or pad.query_caps(None)
        structure = caps.get_structure(0)
        media = structure.get_string("media") or ""
        encoding = structure.get_string("encoding-name") or ""
        chain = STREAM_CHAINS.get(media, {}).get(encoding)
        if chain is None:
            print(f"[{self.name}] ignoring unsupported {media} stream ({encoding})", flush=True)
            return

        elements = []
        for factory_name in chain:
            if factory_name is None:
                continue
            element = Gst.ElementFactory.make(factory_name, None)
            if element is None:
                print(
                    f"[{self.name}] missing GStreamer element {factory_name}; "
                    f"skipping {media} stream ({encoding})",
                    flush=True,
                )
                for e in elements:
                    e.set_state(Gst.State.NULL)
                return
            elements.append(element)

        queue = Gst.ElementFactory.make("queue", f"delay_queue_{len(self.streams)}")
        queue.set_property("max-size-buffers", 0)
        queue.set_property("max-size-bytes", 0)
        queue.set_property("max-size-time", DELAY_NS + 2 * Gst.SECOND)
        queue.set_property("min-threshold-time", DELAY_NS)
        elements.append(queue)

        for element in elements:
            self.pipeline.add(element)
        for upstream, downstream in zip(elements, elements[1:]):
            if not upstream.link(downstream):
                print(f"[{self.name}] failed to link {media} chain ({encoding})", flush=True)
                return

        sink_pad = self.client_sink.get_request_pad("sink_%u")
        if sink_pad is None or queue.get_static_pad("src").link(sink_pad) != Gst.PadLinkReturn.OK:
            print(f"[{self.name}] failed to link {media} stream to rtspclientsink", flush=True)
            return
        if pad.link(elements[0].get_static_pad("sink")) != Gst.PadLinkReturn.OK:
            print(f"[{self.name}] failed to link rtspsrc {media} pad", flush=True)
            self.client_sink.release_request_pad(sink_pad)
            return

        for element in elements:
            element.sync_state_with_parent()

        # 回调运行在流线程中，只更新时间；主循环负责状态切换。
        activity = {"input": None, "output": None}
        queue_sink = queue.get_static_pad("sink")
        queue_src = queue.get_static_pad("src")
        queue_sink.add_probe(Gst.PadProbeType.BUFFER, self.buffer_seen, (activity, "input"))
        queue_src.add_probe(Gst.PadProbeType.BUFFER, self.buffer_seen, (activity, "output"))
        self.streams.append(
            {"media": media, "activity": activity, "started_at": time.monotonic()}
        )
        print(f"[{self.name}] delaying {media} stream ({encoding})", flush=True)

    @staticmethod
    def buffer_seen(pad, info, data):
        activity, key = data
        activity[key] = time.monotonic()
        return Gst.PadProbeReturn.OK

    def destroy_pipeline(self):
        self.running = False
        if self.watchdog_id is not None:
            GLib.source_remove(self.watchdog_id)
            self.watchdog_id = None
        if not self.pipeline:
            return

        # 先解绑 bus 监听，再销毁 pipeline，避免重连时叠加监听。
        print(f"[{self.name}] destroying pipeline")
        if self.bus and self.bus_handler_id:
            self.bus.disconnect(self.bus_handler_id)
            self.bus_handler_id = None
            self.bus.remove_signal_watch()

        pipeline = self.pipeline
        self.pipeline = None
        self.rtspsrc = None
        self.client_sink = None
        self.bus = None
        self.streams = []
        # set_state(NULL) 本身也可能阻塞，不能放在共用的主循环中。
        # 同一路旧实例退出前不创建新实例，避免重复发布和线程累积。
        self.cleanup_thread = threading.Thread(
            target=self.cleanup_pipeline, args=(pipeline,), daemon=True
        )
        self.cleanup_thread.start()
        GLib.timeout_add_seconds(CLEANUP_TIMEOUT, self.check_cleanup, self.cleanup_thread)

    def check_cleanup(self, thread):
        if thread.is_alive() and not self.stopped:
            # A stuck native GStreamer thread cannot be killed safely in Python.
            # Exit so the container supervisor restarts the service.
            print(f"[{self.name}] cleanup timed out; restarting process", flush=True)
            os._exit(1)
        return False

    def cleanup_pipeline(self, pipeline):
        try:
            pipeline.set_state(Gst.State.NULL)
        except Exception as exc:
            print(f"[{self.name}] cleanup failed: {exc}")

    def start(self):
        if self.stopped or self.pipeline:
            return
        if self.cleanup_thread is not None and self.cleanup_thread.is_alive():
            print(f"[{self.name}] waiting for previous pipeline cleanup")
            self.schedule_retry()
            return

        print(f"[{self.name}] starting pipeline: {self.source} -> {self.sink}")
        try:
            self.build_pipeline()
            ret = self.pipeline.set_state(Gst.State.PLAYING)
            if ret == Gst.StateChangeReturn.FAILURE:
                raise RuntimeError("playing failed immediately")
            self.watchdog_id = GLib.timeout_add_seconds(1, self.check_activity)
        except Exception as exc:
            self.fail(f"start failed: {exc}")

    def fail(self, reason):
        print(f"[{self.name}] {reason}")
        self.destroy_pipeline()
        self.schedule_retry()

    def check_activity(self):
        now = time.monotonic()
        if self.stopped:
            self.watchdog_id = None
            return False
        streams = self.streams
        for stream in streams:
            activity = stream["activity"]
            last_input = activity["input"]
            last_output = activity["output"]
            started = stream["started_at"]
            # 首次输出需额外允许延迟队列填满。
            input_stalled = now - (last_input if last_input is not None else started) > STALL_TIMEOUT
            output_stalled = now - (last_output if last_output is not None else started) > (
                STALL_TIMEOUT + DELAY_NS / Gst.SECOND
            )
            if input_stalled or output_stalled:
                self.watchdog_id = None
                self.fail(f"{stream['media']} stalled, reconnecting")
                return False
        if (
            not self.running
            and streams
            and all(s["activity"]["output"] is not None for s in streams)
        ):
            self.running = True
            print(f"[{self.name}] streams flowing to publisher")
        return True

    def stop(self):
        print(f"[{self.name}] stopping")
        self.stopped = True
        self.running = False
        self.cancel_retry()
        self.destroy_pipeline()

    def schedule_retry(self):
        if self.stopped or self.retry_timer_id is not None:
            return

        # 单路异常后进入定时重试，不影响其它摄像头。
        print(f"[{self.name}] retry loop, interval: {RETRY_INTERVAL}s")
        self.retry_timer_id = GLib.timeout_add_seconds(RETRY_INTERVAL, self.retry_tick)

    def cancel_retry(self):
        if self.retry_timer_id:
            GLib.source_remove(self.retry_timer_id)
            self.retry_timer_id = None

    def retry_tick(self):
        # 单次定时器：异步启动失败时可以立即安排下一次重试。
        self.retry_timer_id = None
        if self.stopped:
            return False
        print(f"[{self.name}] retry tick")
        self.start()
        return False

    def bus_message(self, bus, msg):
        if self.stopped or bus != self.bus:
            return True
        msg_type = msg.type
        if msg_type == Gst.MessageType.ERROR:
            err, _ = msg.parse_error()
            self.fail(f"ERROR: {err}")
        elif msg_type == Gst.MessageType.EOS:
            self.fail("EOS")
        return True


class RTSPManager:
    # 统一管理所有自动识别到的摄像头 pipeline。
    def __init__(self, cameras):
        self.loop = GLib.MainLoop()
        self.cameras = [CameraPipeline(c) for c in cameras]

    def start(self):
        if not self.cameras:
            print(
                f"No delayed camera paths found in {MEDIAMTX_CONFIG}. "
                f"Add paths like camera1 and camera1{DELAYED_SUFFIX}."
            )
            self.loop.run()
            return

        print(f"Loaded {len(self.cameras)} delayed camera pipeline(s)")
        for cam in self.cameras:
            cam.start()
        self.loop.run()

    def stop(self):
        for cam in self.cameras:
            cam.stop()
        self.loop.quit()


if __name__ == "__main__":
    manager = RTSPManager(load_cameras(MEDIAMTX_CONFIG))

    signal.signal(signal.SIGINT, lambda s, f: manager.stop())
    signal.signal(signal.SIGTERM, lambda s, f: manager.stop())

    manager.start()
