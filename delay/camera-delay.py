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
延迟参数的 queue 并保留源时间戳，实际音画同步需通过源流和播放器验证。
"""

import os
import multiprocessing
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

# GstRTSPLowerTrans 的 TCP 标志位；该枚举在 GstRtsp 命名空间，容器内没有
# 对应 typelib，直接用数值。
RTSP_LOWER_TRANS_TCP = 4

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
        "MP4A-LATM": ("rtpmp4adepay", "aacparse"),
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
    """One connection attempt, in its own process. The parent owns retries."""

    def __init__(self, cam, channel):
        self.name = cam["name"]
        self.source = cam["source"]
        self.sink = cam["sink"]
        self.channel = channel
        self.loop = GLib.MainLoop()
        self.pipeline = None
        self.client_sink = None
        self.stopped = False
        self.failed = False
        self.pad_lock = threading.Lock()
        self.streams = []
        self.started_at = time.monotonic()
        self.sink_started = False
        self.reported_flow = False

    def notify(self, state):
        self.channel.send(state)

    @staticmethod
    def make(factory):
        element = Gst.ElementFactory.make(factory, None)
        if element is None:
            raise RuntimeError(f"missing GStreamer element: {factory}")
        return element

    @staticmethod
    def stream_key(caps):
        if caps is None or caps.is_empty() or caps.is_any():
            raise ValueError("missing fixed RTP caps")
        structure = caps.get_structure(0)
        return (
            (structure.get_string("media") or "").lower(),
            (structure.get_string("encoding-name") or "").upper(),
            structure.get_value("payload"),
        )

    def build_pipeline(self):
        self.pipeline = Gst.Pipeline.new(None)
        self.rtspsrc = self.make("rtspsrc")
        self.rtspsrc.set_property("location", self.source)
        self.rtspsrc.set_property("protocols", RTSP_LOWER_TRANS_TCP)
        self.rtspsrc.set_property("latency", 200)
        self.rtspsrc.set_property("tcp-timeout", STALL_TIMEOUT * 1000000)
        self.rtspsrc.connect("select-stream", self.select_stream)
        self.rtspsrc.connect("pad-added", self.on_pad_added)
        self.client_sink = self.make("rtspclientsink")
        self.client_sink.set_property("location", self.sink)
        self.client_sink.set_property("protocols", RTSP_LOWER_TRANS_TCP)
        # Do not negotiate the publishing SDP until every selected track is linked.
        self.client_sink.set_locked_state(True)
        self.pipeline.add(self.rtspsrc)
        self.pipeline.add(self.client_sink)
        self.bus = self.pipeline.get_bus()
        self.bus.add_signal_watch()
        self.bus.connect("message", self.bus_message)

    def select_stream(self, src, number, caps):
        # Called during SETUP, before data pads appear. Reserve all sink tracks now.
        with self.pad_lock:
            if self.stopped:
                return False
            try:
                key = self.stream_key(caps)
                media, encoding, _ = key
                chain = STREAM_CHAINS.get(media, {}).get(encoding)
                if chain is None:
                    print(f"[{self.name}] unsupported {media} ({encoding}); skipped", flush=True)
                    return False
                if any(stream["key"][0] == media for stream in self.streams):
                    print(f"[{self.name}] additional {media} track skipped", flush=True)
                    return False
                self.prepare_stream(key, chain)
                return True
            except Exception as exc:
                GLib.idle_add(self.fail, f"stream setup failed: {exc}")
                return False

    def prepare_stream(self, key, chain):
        elements = [self.make(factory) for factory in chain if factory]
        queue = self.make("queue")
        queue.set_property("max-size-buffers", 0)
        queue.set_property("max-size-bytes", 0)
        queue.set_property("max-size-time", DELAY_NS + 2 * Gst.SECOND)
        queue.set_property("min-threshold-time", DELAY_NS)
        elements.append(queue)
        # Any failure tears down this whole attempt; never continue with a partial graph.
        for element in elements:
            self.pipeline.add(element)
        for upstream, downstream in zip(elements, elements[1:]):
            if not upstream.link(downstream):
                raise RuntimeError(f"cannot link {key[:2]}")
        sink_pad = self.client_sink.request_pad_simple("sink_%u")
        if sink_pad is None:
            raise RuntimeError("cannot request publishing pad")
        if queue.get_static_pad("src").link(sink_pad) != Gst.PadLinkReturn.OK:
            raise RuntimeError("cannot link publishing pad")
        activity = {"input": None, "output": None}
        for name, label in (("sink", "input"), ("src", "output")):
            queue.get_static_pad(name).add_probe(
                Gst.PadProbeType.BUFFER, self.buffer_seen, (activity, label)
            )
        self.streams.append({"key": key, "elements": elements,
                             "activity": activity, "linked": False})

    def on_pad_added(self, src, pad):
        with self.pad_lock:
            if self.stopped:
                return
            try:
                key = self.stream_key(pad.get_current_caps() or pad.query_caps(None))
                stream = next((s for s in self.streams if s["key"] == key), None)
                if stream is None or stream["linked"]:
                    raise RuntimeError(f"unexpected RTP pad: {key}")
                target = stream["elements"][0].get_static_pad("sink")
                if pad.link(target) != Gst.PadLinkReturn.OK:
                    raise RuntimeError(f"cannot link input {key[:2]}")
                for element in reversed(stream["elements"]):
                    if not element.sync_state_with_parent():
                        raise RuntimeError("cannot start stream element")
                stream["linked"] = True
                if all(s["linked"] for s in self.streams):
                    if not any(s["key"][0] == "video" for s in self.streams):
                        raise RuntimeError("no supported video track")
                    self.client_sink.set_locked_state(False)
                    if not self.client_sink.sync_state_with_parent():
                        raise RuntimeError("cannot start publisher")
                    self.sink_started = True
                print(f"[{self.name}] linked {key[0]} ({key[1]})", flush=True)
            except Exception as exc:
                GLib.idle_add(self.fail, f"stream link failed: {exc}")

    @staticmethod
    def buffer_seen(pad, info, data):
        activity, key = data
        activity[key] = time.monotonic()
        return Gst.PadProbeReturn.OK

    def fail(self, reason):
        if not self.stopped:
            self.failed = True
            print(f"[{self.name}] {reason}", flush=True)
            self.stopped = True
            self.loop.quit()
        return False

    def stop(self):
        self.stopped = True
        self.loop.quit()
        return False

    def check_activity(self):
        if self.stopped:
            return False
        now = time.monotonic()
        # Includes SDP/SETUP and no-pad failures, not just already-created streams.
        with self.pad_lock:
            streams = list(self.streams)
        video = next((s for s in streams if s["key"][0] == "video"), None)
        if video is None or not self.sink_started:
            if now - self.started_at > STALL_TIMEOUT + DELAY_NS / Gst.SECOND:
                return self.fail("startup timed out: no complete video/audio pipeline")
            self.notify("starting")
            return True
        activity = video["activity"]
        if now - (activity["input"] or self.started_at) > STALL_TIMEOUT:
            return self.fail("video input stalled")
        if now - (activity["output"] or self.started_at) > STALL_TIMEOUT + DELAY_NS / Gst.SECOND:
            return self.fail("video output stalled")
        # Audio silence/DTX must not continually restart a healthy video stream.
        # A selected audio track must nevertheless produce initial output.
        for stream in streams:
            if stream["activity"]["output"] is None:
                if now - self.started_at > STALL_TIMEOUT + DELAY_NS / Gst.SECOND:
                    return self.fail("selected track produced no initial data")
                self.notify("starting")
                return True
        if not self.reported_flow:
            print(f"[{self.name}] media flowing to publisher", flush=True)
            self.reported_flow = True
        self.notify("flowing")
        return True

    def bus_message(self, bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            error, debug = msg.parse_error()
            self.fail(f"ERROR: {error}; {debug or ''}")
        elif msg.type == Gst.MessageType.EOS:
            self.fail("EOS")

    def run(self):
        signal.signal(signal.SIGINT, lambda *_: GLib.idle_add(self.stop))
        signal.signal(signal.SIGTERM, lambda *_: GLib.idle_add(self.stop))
        try:
            self.notify("starting")
            self.build_pipeline()
            if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise RuntimeError("pipeline failed to start")
            GLib.timeout_add_seconds(1, self.check_activity)
            self.loop.run()
        except Exception as exc:
            self.failed = True
            print(f"[{self.name}] worker failed: {exc}", flush=True)
        finally:
            self.notify("stopping")
            with self.pad_lock:
                self.stopped = True
            # Parent enforces the deadline even if this native call never returns.
            if self.pipeline is not None:
                if self.client_sink is not None:
                    self.client_sink.set_locked_state(False)
                self.pipeline.set_state(Gst.State.NULL)
            self.channel.close()
        return 1 if self.failed else 0


def run_camera(cam, channel):
    raise SystemExit(CameraPipeline(cam, channel).run())


class CameraProcess:
    """Independent, fixed-interval retries for one camera."""

    def __init__(self, cam, context):
        self.cam = cam
        self.context = context
        self.process = None
        self.channel = None
        self.next_start = 0
        self.stop_deadline = None
        self.kill_deadline = None

    def start(self, now):
        receiver, sender = self.context.Pipe(duplex=False)
        self.process = self.context.Process(target=run_camera, args=(self.cam, sender), daemon=True)
        try:
            self.process.start()
        except Exception:
            receiver.close()
            sender.close()
            self.process = None
            raise
        sender.close()
        self.channel = receiver
        self.last_heartbeat = now
        self.stop_deadline = None
        self.kill_deadline = None
        print(f"[{self.cam['name']}] worker started pid={self.process.pid}", flush=True)

    def schedule(self, now):
        self.next_start = now + RETRY_INTERVAL
        print(f"[{self.cam['name']}] retry in {RETRY_INTERVAL}s", flush=True)

    def tick(self, now):
        if self.process is None:
            if now >= self.next_start:
                try:
                    self.start(now)
                except Exception as exc:
                    print(f"[{self.cam['name']}] cannot spawn worker: {exc}", flush=True)
                    self.schedule(now)
            return
        try:
            while self.channel.poll():
                state = self.channel.recv()
                self.last_heartbeat = now
                if state == "stopping":
                    if self.stop_deadline is None:
                        self.stop_deadline = now + CLEANUP_TIMEOUT
        except (EOFError, OSError):
            pass
        if not self.process.is_alive():
            self.process.join()
            self.process.close()
            self.channel.close()
            self.process = None
            self.schedule(now)
            return
        if self.kill_deadline is not None:
            if now >= self.kill_deadline:
                self.process.kill()
                self.kill_deadline = now + 3
            return
        heartbeat_expired = now - self.last_heartbeat > STALL_TIMEOUT + DELAY_NS / Gst.SECOND + CLEANUP_TIMEOUT
        cleanup_expired = self.stop_deadline is not None and now >= self.stop_deadline
        if heartbeat_expired or cleanup_expired:
            print(f"[{self.cam['name']}] worker stuck; terminating only this camera", flush=True)
            self.process.terminate()
            self.kill_deadline = now + 3


class RTSPManager:
    def __init__(self, cameras):
        context = multiprocessing.get_context("spawn")
        self.cameras = [CameraProcess(cam, context) for cam in cameras]
        self.stopped = False

    def stop(self):
        self.stopped = True

    def start(self):
        print(f"Loaded {len(self.cameras)} camera worker(s)", flush=True)
        try:
            while not self.stopped:
                now = time.monotonic()
                for camera in self.cameras:
                    camera.tick(now)
                time.sleep(0.5)
        finally:
            workers = [c for c in self.cameras if c.process is not None]
            for camera in workers:
                if camera.process.is_alive():
                    camera.process.terminate()
            deadline = time.monotonic() + 3
            for camera in workers:
                camera.process.join(max(0, deadline - time.monotonic()))
                if camera.process.is_alive():
                    camera.process.kill()
            for camera in workers:
                camera.process.join(1)
                camera.channel.close()


if __name__ == "__main__":
    manager = RTSPManager(load_cameras(MEDIAMTX_CONFIG))
    signal.signal(signal.SIGINT, lambda *_: manager.stop())
    signal.signal(signal.SIGTERM, lambda *_: manager.stop())
    manager.start()
