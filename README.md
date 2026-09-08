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

GitHub Actions 会在推送到 `main` / `master`、推送 `v*` 标签、Pull Request 或手动触发时构建镜像，并发布到 GitHub Container Registry：

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

- `path`：摄像头路径。
- `start`：开始时间，使用 URL 编码后的 RFC3339 时间。
- `duration`：回放时长，单位秒。

健康检查：

```text
http://服务器IP:9995/health
```

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
    recordDeleteAfter: 2160h

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

延迟转发按 RTP 协商信息选择编码：视频支持 H.264 和 H.265，音频支持 PCMA、PCMU、AAC（MP4A-LATM / MPEG4-GENERIC）和 Opus。每台摄像头选择第一条支持的视频轨道和第一条支持的音频轨道；无音频时仅转发视频，其它编码和额外轨道会跳过并打印日志。没有支持的视频轨道或建链失败时，该路进入重试。新增或修改摄像头配对后，需要执行 `docker compose restart mediamtx` 重新读取配置。

每路摄像头使用独立子进程。每次失败且旧进程退出后，固定等待 30 秒重试，不增加等待时间、不限制重试次数，直到恢复或服务停止。`RETRY_INTERVAL` 可修改固定重试间隔。持续 30 秒无视频输入会触发重连，首次建链和输出检测额外预留配置的延迟时间，`STALL_TIMEOUT` 可修改检测阈值。

清理超过 15 秒或子进程失去心跳时，管理进程只终止并重建该摄像头子进程，不退出整个容器。终止后 3 秒仍未退出则强制结束；旧进程未退出前不创建新实例。直接运行脚本也使用同一套管理机制。停止管理进程时会同时终止其摄像头子进程。

音频建立后需有首次数据；后续静音或 DTX 不会单独触发整路重连。这样避免静音造成反复重连，但仅音频永久卡流时也不会主动重连。音视频使用相同管线时钟和延迟偏移，不转码；实际端到端同步以及 H.265、G.711 等编码的播放兼容性仍取决于源流和播放器。源端声明音频却一直不发送数据时，该路会启动超时重试。

延迟由 GStreamer 单调时钟和 buffer 时间戳调度：`clocksync` 在原始时间戳上增加 `DELAY_NS`，到达目标时刻才释放数据。`queue` 只提供等待期间的存储空间，其容量比目标延迟多 1 秒以避免边界丢帧，这 1 秒不会加入计划延迟。队列满时丢弃最旧的数据，避免阻塞 RTSP/TCP 输入并在网络缓冲区继续累积延迟。

RTSP over TCP 在运行时支持 `tcp-timestamp` 时，会使用数据接收时间抑制摄像头时钟与服务器时钟的长期漂移；旧版 GStreamer 不支持该属性时会打印提示。延迟脚本连接的是同机 MediaMTX，因此收发两端的附加 latency 均设为 0，内部 jitterbuffer 开启 `drop-on-latency`。日志每 60 秒输出一次各轨道的 `queue levels`；该值稳定但观看延迟继续增加时，额外延迟来自 MediaMTX 输出协议或播放器缓存。

回放临时文件默认存放在内存盘 `/dev/shm`，可通过 `TEMP_DIR` 修改；Compose 已配置 `shm_size: "1g"` 覆盖 Docker 默认的 64MB。生成没有并发数量限制；`TEMP_DIR` 指向磁盘目录时，磁盘需要足够的可用空间。

定时清理只删除缓存目录中超过保留时间的完整 MP4；开启 `CACHE_KEEP_FOREVER` 时完全跳过清理。临时文件和半成品不做自动清理——默认放在 `/dev/shm`，容器删除后即清空。

## 直接运行镜像

推荐使用 host 网络：

```bash
docker run --rm -it --network=host \
  -e MEDIAMTX_CONFIG=/config/mediamtx.yml \
  -e DELAY_NS=4000000000 \
  -v ./mediamtx.yml:/config/mediamtx.yml:ro \
  -v ./recordings:/data/recordings \
  -v ./media_cache:/app/proxy/media_cache \
  ghcr.io/saneslark/mediamtx:latest
```

如果不使用 host 网络，需要按需映射端口：

```bash
docker run --rm -it \
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
