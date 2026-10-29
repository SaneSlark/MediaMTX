# MediaMTX Replay Proxy

`replay` 分支提供独立的代理回放镜像，仅运行 `proxy/replay-proxy.js`，包含 Node.js、FFmpeg 和 tini。MediaMTX 的录制与 playback 服务需要单独部署；镜像不启动 MediaMTX 或延迟转发服务，也不需要挂载原始录像或 `mediamtx.yml`。

代理从外部 MediaMTX playback 的 `/get` 接口下载录像片段，经 FFmpeg 整理为 MP4 后缓存，支持 HTTP Range 拖动播放。原有 `main` 分支继续提供完整服务。

## 构建与启动

```bash
docker compose up -d --build
```

默认监听宿主机 `9995`，连接宿主机上的 `http://host.docker.internal:9996`。Compose 配置了 `host-gateway`，可用于 Linux Docker Engine；Docker Desktop 同样支持该宿主机地址。宿主机的 MediaMTX playback 需要监听容器可访问的地址（例如 `:9996`），仅监听 `127.0.0.1` 时，桥接容器无法访问。

如果 MediaMTX 在另一台服务器，可在 `.env` 文件中设置：

```dotenv
MEDIAMTX_BASE=http://192.168.1.100:9996
```

然后重新执行 `docker compose up -d`。如果 MediaMTX 在其他容器中，需要让两个容器加入同一个 Docker 网络，并把 `MEDIAMTX_BASE` 设置为对应服务地址。

可以复制 `.env.example` 为 `.env` 后修改；`.env` 已排除出 Git 和镜像构建上下文。

如果同机原有完整服务已占用 `9995`，请先修改本分支 Compose 的宿主机端口映射，例如 `9994:9995`。

也可以单独构建和运行（将示例服务器地址替换为实际地址）：

```bash
docker build -t mediamtx-replay:local .
docker run -d --name mediamtx-replay --restart unless-stopped \
  -p 9995:9995 --shm-size=1g \
  -e MEDIAMTX_BASE=http://192.168.1.100:9996 \
  -v "$(pwd)/media_cache:/app/proxy/media_cache" \
  mediamtx-replay:local
```

## 镜像发布

推送到 `replay` 分支后，GitHub Actions 会构建并发布独立镜像：

```text
ghcr.io/saneslark/mediamtx-replay:latest
ghcr.io/saneslark/mediamtx-replay:replay
```

仓库所有者或仓库名改变时，镜像地址自动使用 `<仓库全名>-replay`。Pull Request 到 `replay` 只做构建验证；手动触发可以指定额外版本标签。镜像发布成功后可直接运行：

```bash
docker compose pull
docker compose up -d --no-build
```

## 接口

```text
GET /health
GET /get?path=camera1&start=2026-10-29T10%3A00%3A00Z&duration=60
```

- `path`：MediaMTX 摄像头路径，仅支持字母、数字、下划线和短横线。
- `start`：URL 编码后的 RFC3339 开始时间。
- `duration`：片段时长，单位秒，默认上限 3600 秒。

完整请求示例：

```text
http://localhost:9995/get?path=camera1&start=2026-10-29T10%3A00%3A00Z&duration=60
```

返回 MP4，支持 HTTP Range；相同片段正在生成时返回 `202`，稍后重试。参数错误返回 `400`，生成失败返回 `500`。录像列表仍直接请求外部 MediaMTX 的 `/list?path=camera1`。

## 配置与缓存

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEDIAMTX_BASE` | Compose 为 `http://host.docker.internal:9996` | 外部 MediaMTX playback 地址；直接运行脚本时默认 `http://localhost:9996` |
| `PORT` | `9995` | 容器内 HTTP 端口；修改后需要同步端口映射 |
| `CACHE_DIR` | `/app/proxy/media_cache` | MP4 缓存目录，Compose 挂载到本地 `./media_cache` |
| `TEMP_DIR` | `/dev/shm` | 下载临时目录，Compose 共享内存大小为 1 GB |
| `CACHE_KEEP_FOREVER` | `false` | 为 `true` 时永久保留缓存 |
| `CACHE_TTL_DAYS` | `90` | 缓存有效天数 |
| `CLEAN_INT_DAYS` | `1` | 缓存清理间隔天数 |
| `DOWNLOAD_TIMEOUT_MS` | `120000` | 下载超时毫秒数 |
| `FFMPEG_TIMEOUT_MS` | `60000` | FFmpeg 处理超时毫秒数 |
| `MAX_DURATION` | `3600` | 最大片段秒数 |

可以用 `CACHE_TTL_MS` 和 `CLEAN_INTERVAL_MS` 覆盖对应的天数配置。缓存按摄像头和 UTC 日期分目录保存，有效期按文件修改时间计算；原始录像由外部 MediaMTX 独立管理。

临时文件与生成中的半成品会在任务结束时清理，进程异常退出的残留不由定时任务清理。不同片段可并发生成，请根据录像码率、时长和并发量调整共享内存大小。

Docker 内置 `/health` 健康检查，仅检查代理进程是否可响应；上游连接和 FFmpeg 处理需要实际回放请求验证。

## 源码与验证

分支只保留回放代理源码、依赖锁文件、自动化测试和 Docker 部署配置。完整服务的 `delay/`、`docker-entrypoint.sh` 和 `mediamtx.example.yml` 已移除。

```bash
cd proxy
npm ci
npm run check
npm test
```

测试覆盖参数校验、CORS、Range/HEAD、缓存过期与永久保留、并发去重、上游错误、超时和下载中断清理。安装 FFmpeg 后，还会验证有声/无声 MP4 生成、实际解码、faststart、缓存复用、损坏媒体与 FFmpeg 超时；本地缺少 FFmpeg 时这三组测试会跳过。

GitHub Actions 在实际构建出的镜像内强制执行全部测试，再检查默认启动命令和 Docker 健康检查，通过后才发布镜像。测试代码通过只读挂载提供，不进入发布镜像。测试使用临时目录和模拟 playback 上游，不连接生产摄像头。
