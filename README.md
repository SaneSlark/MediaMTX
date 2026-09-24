# MediaMTX

## 功能说明

这个项目把 MediaMTX、回放代理和延迟转发脚本打包到一个 Docker 镜像里，适合在 Linux 服务器上运行。

主要功能：

- MediaMTX：负责 RTSP/RTMP/HLS/WebRTC/SRT 拉流、发布、录制和回放。
- 录像保存：按 `mediamtx.yml` 中的 `recordPath` 保存到容器内 `/data/recordings`，Compose 默认映射到本地 `./recordings`。
- 回放代理：`proxy/replay-proxy.js` 提供 `/get` 接口，把 MediaMTX playback 的片段下载后用 FFmpeg 整理为浏览器友好的 MP4，并支持 HTTP Range 拖动播放。
- 缓存管理：回放代理会把生成后的 MP4 缓存在 `/app/proxy/media_cache`，Compose 默认映射到本地 `./media_cache`。
- 延迟转发：`delay/camera-delay.py` 会读取 `mediamtx.yml` 的 `paths`，自动识别 `camera1` / `camera1-5s` 这类配对路径，并用 GStreamer 做约 5 秒延迟转发。
- 自动扩展摄像头：新增摄像头只需要改 `mediamtx.yml` 的 `paths`，不需要再改 Python 或 Node 代码。

示例配置默认启用 RTSP、WebRTC、录像和回放；RTMP、HLS、SRT、MoQ 默认关闭，需要时可在 `mediamtx.yml` 中启用。

## 镜像构建

GitHub Actions 会在推送到 `main` / `master`、推送 `v*` 标签或手动触发时构建镜像并发布到 GitHub Container Registry；Pull Request 仅构建验证：

```bash
ghcr.io/saneslark/mediamtx:latest
```

Dockerfile 会从 `bluenviron/mediamtx:latest` 复制 MediaMTX 二进制，然后在最终 Ubuntu 26.04 LTS 镜像中安装运行依赖，包括 FFmpeg、GStreamer、Node.js 和 Python。Ubuntu 26.04 提供的 GStreamer 版本支持 RTSP TCP 接收时间戳，用于抑制长时间运行后的时钟漂移。

## 使用 Docker Compose 运行

首次运行前复制示例配置：

```bash
cp mediamtx.example.yml mediamtx.yml
```

按实际摄像头地址修改本地 `mediamtx.yml` 后启动：

```bash
docker compose up -d
```

镜像不会包含 `mediamtx.yml`；Compose 会把本地配置挂载到容器内 `/config/mediamtx.yml`。真实配置里通常包含摄像头账号密码，请只保留在本地。

## 目录映射

Compose 默认使用本地目录：

```text
./recordings   -> /data/recordings
./media_cache  -> /app/proxy/media_cache
./mediamtx.yml -> /config/mediamtx.yml
```

## 缓存保留时间

回放代理生成的 MP4 缓存在 `./media_cache`，默认保留 90 天，每天清理一次。可以在 `docker-compose.yml` 里调整：

```yaml
CACHE_KEEP_FOREVER: "false"
CACHE_TTL_DAYS: 90
CLEAN_INT_DAYS: 1
```

如果要永久保留缓存，设置：

```yaml
CACHE_KEEP_FOREVER: "true"
```

如果需要更精确的毫秒级配置，也可以使用 `CACHE_TTL_MS` 和 `CLEAN_INTERVAL_MS`。

缓存按摄像头和日期分目录保存，保留时间按文件修改时间计算。过期缓存会在请求时失效，定时清理仅删除过期的完整 MP4；`CACHE_KEEP_FOREVER` 开启时跳过过期检查和定时清理。

原始录像独立管理：示例配置通过 `recordDeleteAfter: 30d` 保留 30 天，与 MP4 缓存保留期无关。

## 录像回放列表

MediaMTX 回放列表接口：

```text
http://服务器IP:9996/list?path=camera1
```

按时间范围查询：

```text
http://服务器IP:9996/list?path=camera1&start=2026-08-25T00%3A00%3A00Z&end=2026-08-25T23%3A59%3A59Z
```

`path` 对应 `mediamtx.yml` 里的摄像头路径，例如 `camera1`、`camera2`。

## 回放代理

代理接口会从 MediaMTX 取录像片段，并缓存为浏览器更容易播放的 MP4：

```text
http://服务器IP:9995/get?path=camera1&start=2026-08-25T10%3A00%3A00Z&duration=60
```

参数说明：

- `path`：摄像头路径，仅支持字母、数字、下划线和短横线。
- `start`：开始时间，使用 URL 编码后的 RFC3339 时间。
- `duration`：回放时长，单位秒，必须大于 0；默认上限 3600 秒，可通过 `MAX_DURATION` 调整。

缓存命中后直接返回 MP4，支持 HTTP Range 拖动播放；相同片段正在生成时返回 `202`，客户端需稍后重试。参数无效返回 `400`，生成失败返回 `500`。

健康检查：

```text
http://服务器IP:9995/health
```

回放临时文件默认放在 `/dev/shm`，可用 `TEMP_DIR` 修改；半成品放在缓存目录。任务结束时会尝试清理两者，进程异常退出的残留文件不由定时任务清理。Compose 已将共享内存设为 1 GB；不同片段的生成任务不限并发，需留足空间。

下载和 FFmpeg 处理默认分别在 120 秒、60 秒后超时，可通过 `DOWNLOAD_TIMEOUT_MS`、`FFMPEG_TIMEOUT_MS` 调整。

## 新增摄像头

在 `mediamtx.yml` 的 `paths` 中增加原始路径和延迟发布路径即可。例如：

```yaml
paths:
  camera5:
    source: rtsp://USER:PASSWORD@CAMERA_HOST:554/unicast/c5/s0/live
    record: yes
    recordPath: /data/recordings/%path/%Y%m%d_%H%M%S_%f
    recordFormat: fmp4
    recordPartDuration: 10s
    recordSegmentDuration: 1h
    recordDeleteAfter: 30d

  camera5-5s:
    source: publisher
```

`delay/camera-delay.py` 会自动识别上面的配对，并创建：

```text
rtsp://127.0.0.1:8554/camera5 -> rtsp://127.0.0.1:8554/camera5-5s
```

延迟时间可通过环境变量调整，单位是纳秒：

```yaml
DELAY_NS: 5000000000  # 约 5 秒
```

路径名里的 `-5s` 只是名称，实际延迟以 `DELAY_NS` 为准。

新增或修改摄像头配对后，执行 `docker compose restart mediamtx` 使配置生效。

## 延迟转发

- **编码支持**：视频支持 H.264 / H.265；音频支持 PCMA、PCMU、AAC（MP4A-LATM / MPEG4-GENERIC）和 Opus。每路只转发首条支持的视频和音频轨道，不转码；无音频时仅转发视频。
- **自动恢复**：每路摄像头独立运行，失败后默认每 30 秒重试，次数不限；连续 30 秒无视频输入触发重连。分别通过 `RETRY_INTERVAL`、`STALL_TIMEOUT` 调整。
- **音频检测**：声明音频却始终无数据会触发启动超时；收到首次数据后，静音、DTX 或仅音频卡流不会单独触发重连。

## 运行机制与延迟排查

- **轨道选择**：不支持的编码和额外轨道会跳过并记录日志；无可用视频轨道或建链失败时重试。播放兼容性和端到端音画同步取决于源流及播放器。
- **进程管理**：清理超过 15 秒或丢失心跳时，只重建对应摄像头子进程；终止后 3 秒未退出则强制结束。旧进程退出后才开始等待重试，首次建链和输出检测额外预留配置的延迟时间。直接运行脚本使用相同机制，停止管理进程会同时终止所有摄像头子进程。
- **延迟调度**：`clocksync` 按单调时钟和原始时间戳加 `DELAY_NS` 释放数据。队列容量额外预留 1 秒，但不增加计划延迟；满时丢弃最旧数据，避免输入阻塞和延迟累积。
- **时钟与缓冲**：支持时启用 `tcp-timestamp` 抑制长期时钟漂移，不支持则记录提示。连接同机 MediaMTX 时，收发附加 latency 均为 0，jitterbuffer 启用 `drop-on-latency`。
- **排查入口**：日志每 60 秒输出各轨道的 `queue levels`。队列稳定但观看延迟持续增加时，可检查 MediaMTX 输出协议和播放器缓存。

## 直接运行镜像

推荐使用 host 网络：

```bash
docker run --rm -it --network=host --shm-size=1g \
  -e MEDIAMTX_CONFIG=/config/mediamtx.yml \
  -e DELAY_NS=5000000000 \
  -v ./mediamtx.yml:/config/mediamtx.yml:ro \
  -v ./recordings:/data/recordings \
  -v ./media_cache:/app/proxy/media_cache \
  ghcr.io/saneslark/mediamtx:latest
```

如果不使用 host 网络，需要按需映射端口：

```bash
docker run --rm -it --shm-size=1g \
  -e MEDIAMTX_CONFIG=/config/mediamtx.yml \
  -p 8554:8554 \
  -p 1935:1935 \
  -p 8888:8888 \
  -p 8889:8889 \
  -p 8000:8000/udp \
  -p 8001:8001/udp \
  -p 8189:8189/udp \
  -p 8890:8890/udp \
  -p 9995:9995 \
  -p 9996:9996 \
  -p 9997:9997 \
  -v ./mediamtx.yml:/config/mediamtx.yml:ro \
  -v ./recordings:/data/recordings \
  -v ./media_cache:/app/proxy/media_cache \
  ghcr.io/saneslark/mediamtx:latest
```
