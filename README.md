# MediaMTX

## 功能说明

这个项目把 MediaMTX、回放代理和延迟转发脚本打包到一个 Docker 镜像里，适合在 Linux 服务器上运行。

主要功能：

- MediaMTX：负责 RTSP/RTMP/HLS/WebRTC/SRT 拉流、发布、录制和回放。
- 录像保存：按 `mediamtx.yml` 中的 `recordPath` 保存到容器内 `/data/recordings`，Compose 默认映射到本地 `./recordings`。
- 回放代理：`proxy/proxy.js` 提供 `/get` 接口，把 MediaMTX playback 的片段下载后用 FFmpeg 整理为浏览器友好的 MP4，并支持 HTTP Range 拖动播放。
- 缓存管理：回放代理会把生成后的 MP4 缓存在 `/app/proxy/media_cache`，Compose 默认映射到本地 `./media_cache`。
- 延迟转发：`delay/camera.py` 会读取 `mediamtx.yml` 的 `paths`，自动识别 `camera1` / `camera1-5s` 这类配对路径，并用 GStreamer 做约 5 秒延迟转发。
- 自动扩展摄像头：新增摄像头只需要改 `mediamtx.yml` 的 `paths`，不需要再改 Python 或 Node 代码。

## 镜像构建

GitHub Actions 会在推送到 `main` / `master`、推送 `v*` 标签、Pull Request 或手动触发时构建镜像，并发布到 GitHub Container Registry：

```bash
ghcr.io/saneslark/mediamtx:latest
```

Dockerfile 会从 `bluenviron/mediamtx:latest` 复制 MediaMTX 二进制，然后在最终 Ubuntu 镜像中安装运行依赖，包括 FFmpeg、GStreamer、Node.js 和 Python。

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
CLEAN_INTERVAL_DAYS: 1
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

`delay/camera.py` 会自动识别上面的配对，并创建：

```text
rtsp://127.0.0.1:8554/camera5 -> rtsp://127.0.0.1:8554/camera5-5s
```

延迟时间可通过环境变量调整，单位是纳秒：

```yaml
DELAY_NS: 4000000000  # 约 4 秒
```

路径名里的 `-5s` 只是名称，实际延迟以 `DELAY_NS` 为准。

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
  -p 9995:9995 \
  -p 9996:9996 \
  -p 9997:9997 \
  -v ./mediamtx.yml:/config/mediamtx.yml:ro \
  -v ./recordings:/data/recordings \
  -v ./media_cache:/app/proxy/media_cache \
  ghcr.io/saneslark/mediamtx:latest
```
