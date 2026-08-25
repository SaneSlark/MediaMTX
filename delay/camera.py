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
"""

import os
import signal
import sys

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
RETRY_INTERVAL = int(os.environ.get("RETRY_INTERVAL", "60"))

# GStreamer pipeline 参数：读取原始 RTSP 流，缓存 5 秒后推送到延迟流。
PIPELINE_CMD = (
    'rtspsrc location="{source}" protocols=tcp latency=0 ! '
    "rtph264depay ! h264parse ! "
    "queue max-size-buffers=0 max-size-bytes=0 "
    "min-threshold-time={delay_ns} leaky=0 ! "
    'rtspclientsink location="{sink}" protocols=tcp'
)


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
        self.bus = None
        self.bus_handler_id = None
        self.retry_timer_id = None
        self.running = False

    def build_pipeline(self):
        desc = PIPELINE_CMD.format(
            source=self.source,
            sink=self.sink,
            delay_ns=DELAY_NS,
        )
        self.pipeline = Gst.parse_launch(desc)
        self.bus = self.pipeline.get_bus()
        self.bus.add_signal_watch()
        self.bus_handler_id = self.bus.connect("message", self.bus_message)

    def destroy_pipeline(self):
        if not self.pipeline:
            return

        # 先解绑 bus 监听，再销毁 pipeline，避免重连时叠加监听。
        print(f"[{self.name}] destroying pipeline")
        if self.bus and self.bus_handler_id:
            self.bus.disconnect(self.bus_handler_id)
            self.bus_handler_id = None
            self.bus.remove_signal_watch()

        self.pipeline.set_state(Gst.State.NULL)
        self.pipeline.get_state(Gst.CLOCK_TIME_NONE)
        self.pipeline = None
        self.bus = None

    def start(self):
        if self.pipeline:
            return

        print(f"[{self.name}] starting pipeline: {self.source} -> {self.sink}")
        self.build_pipeline()
        ret = self.pipeline.set_state(Gst.State.PLAYING)

        if ret == Gst.StateChangeReturn.FAILURE:
            print(f"[{self.name}] playing failed immediately")
            self.running = False
            self.schedule_retry()
        else:
            self.running = True

    def stop(self):
        print(f"[{self.name}] stopping")
        self.running = False
        self.cancel_retry()
        self.destroy_pipeline()

    def schedule_retry(self):
        if self.retry_timer_id is not None:
            return

        # 单路异常后进入定时重试，不影响其它摄像头。
        print(f"[{self.name}] retry loop, interval: {RETRY_INTERVAL}s")
        self.retry_timer_id = GLib.timeout_add_seconds(RETRY_INTERVAL, self.retry_tick)

    def cancel_retry(self):
        if self.retry_timer_id:
            GLib.source_remove(self.retry_timer_id)
            self.retry_timer_id = None

    def retry_tick(self):
        print(f"[{self.name}] retry tick")
        self.destroy_pipeline()
        self.start()

        if self.running:
            print(f"[{self.name}] recovered")
            self.retry_timer_id = None
            return False
        return True

    def bus_message(self, bus, msg):
        msg_type = msg.type
        if msg_type == Gst.MessageType.ERROR:
            err, _ = msg.parse_error()
            print(f"[{self.name}] ERROR: {err}")
            self.running = False
            self.destroy_pipeline()
            self.schedule_retry()
        elif msg_type == Gst.MessageType.EOS:
            print(f"[{self.name}] EOS")
            self.running = False
            self.destroy_pipeline()
            self.schedule_retry()
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
