# MediaMTX Replay Proxy

`replay` 分支提供独立的代理回放镜像，使用轻量化的 `node:22-alpine` 基础镜像，仅运行 `proxy/replay-proxy.js`，包含 Node.js、FFmpeg 和 tini。MediaMTX 的录制与 playback 服务需要单独部署；镜像不启动 MediaMTX 或延迟转发服务，也不需要挂载原始录像或 `mediamtx.yml`。

代理从外部 MediaMTX playback 的 `/get` 接口读取分片 MP4，直接送入 FFmpeg，边下载边在内存盘生成支持 HTTP Range 的普通 MP4。生成完成后立即从内存文件响应播放，同时后台保存磁盘缓存，减少首次回放等待。原有 `main` 分支继续提供完整服务。

## 从源码构建与启动

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
docker run -d --name mediamtx-replay --restart unless-stopped --shm-size=1g \
  -p 9995:9995 \
  -e MEDIAMTX_BASE=http://192.168.1.100:9996 \
  -v "$(pwd)/media_cache:/app/proxy/media_cache" \
  mediamtx-replay:local
```

## 镜像发布

推送到 `replay` 分支后，GitHub Actions 会构建并发布独立镜像：

```text
ghcr.io/saneslark/mediamtx-replay:latest
ghcr.io/saneslark/mediamtx-replay:replay
ghcr.io/saneslark/mediamtx-replay:v1.0.0
```

推送 `replay-v1.0.0` 这类 Git 标签会发布对应的 `v1.0.0` 镜像版本；回放版本使用 `replay-v*` 标签，与完整服务的版本标签区分。

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

返回 MP4，支持 HTTP Range；相同片段正在生成时返回 `202`，内存任务名额已满时返回 `503`，均可稍后重试。参数错误返回 `400`，生成失败返回 `500`。录像列表仍直接请求外部 MediaMTX 的 `/list?path=camera1`。

## 配置与缓存

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEDIAMTX_BASE` | Compose 为 `http://host.docker.internal:9996` | 外部 MediaMTX playback 地址；直接运行脚本时默认 `http://localhost:9996` |
| `TZ` | `Asia/Shanghai` | 容器时区；镜像包含时区数据，可通过环境变量调整 |
| `PORT` | `9995` | 容器内 HTTP 端口；修改后需要同步端口映射 |
| `CACHE_DIR` | `/app/proxy/media_cache` | MP4 缓存目录，Compose 挂载到本地 `./media_cache` |
| `MEMORY_DIR` | `/dev/shm` | MP4 生成目录，需位于内存盘；Compose 共享内存上限 1 GB |
| `MAX_MEMORY_JOBS` | `2` | 同时占用内存文件的任务上限，包括生成、后台保存和播放中的任务 |
| `CACHE_KEEP_FOREVER` | `true` | 默认永久保留缓存；设为 `false` 后启用过期检查和定时清理 |
| `CACHE_TTL_DAYS` | `90` | 缓存有效天数 |
| `CLEAN_INT_DAYS` | `1` | 缓存清理间隔天数 |
| `DOWNLOAD_TIMEOUT_MS` | `120000` | 下载超时毫秒数 |
| `FFMPEG_TIMEOUT_MS` | `60000` | FFmpeg 处理超时毫秒数 |
| `MAX_DURATION` | `3600` | 最大片段秒数 |

默认永久保留缓存，`CACHE_KEEP_FOREVER=false` 时才按有效期检查和定时清理，默认有效期 90 天、每天清理一次。可以用 `CACHE_TTL_MS` 和 `CLEAN_INTERVAL_MS` 覆盖对应的天数配置。缓存按摄像头和 UTC 日期分目录保存，有效期按文件修改时间计算；原始录像由外部 MediaMTX 独立管理。

原始下载数据直接进入 FFmpeg，不另存原始文件。FFmpeg 在 `MEMORY_DIR` 内完成 MP4 和 faststart 整理，生成后先从该文件响应，同时后台复制到磁盘的 `.partial.mp4`，复制成功后原子重命名为正式缓存。后台保存期间，相同片段的请求可继续从内存播放；保存和正在进行的播放都结束后释放内存文件。

默认 `MAX_MEMORY_JOBS=2`，名额用完时新片段请求返回 `503` 和 `Retry-After: 1`；已生成的内存文件和磁盘缓存仍可访问。Compose 的 `shm_size: "1g"` 限定共享内存容量，可按码率、片段时长及并发量调整；文件超过可用容量时生成会失败并清理，不会发布不完整的缓存。`MEMORY_DIR` 改到普通磁盘目录就失去内存加速效果。

后台保存失败会记录 `[CACHE]` 日志，当前播放继续，播放结束后释放内存；之后再次请求会重新生成。容器停止前尚未完成保存的内存片段不会持久保留，已有磁盘缓存按 `CACHE_KEEP_FOREVER` 等配置管理。异常退出留下的磁盘半成品不由定时任务清理。

首次回放仍需等待该片段生成完成，随后才能返回可拖动的 MP4；片段越长，首播等待通常也越长。可以先请求较短片段。日志中的 `[PERF]` 会记录未缓存片段的总生成耗时，便于判断实际改善；已缓存片段仍直接读取文件。

Docker 内置 `/health` 健康检查，仅检查代理进程是否可响应；上游连接和 FFmpeg 处理需要实际回放请求验证。


## 最简 Docker Compose 配置

新建 `docker-compose.yml`，填入以下内容，只需把 `MEDIAMTX_BASE` 改成你的 MediaMTX playback 地址：

```yaml
services:
  replay:
    image: ghcr.io/saneslark/mediamtx-replay:latest
    restart: unless-stopped
    shm_size: "1g"
    ports:
      - "9995:9995"
    environment:
      MEDIAMTX_BASE: http://192.168.1.100:9996
    volumes:
      - ./media_cache:/app/proxy/media_cache
```

在该文件所在目录执行：

```bash
docker compose pull
docker compose up -d
```

启动后访问 `http://服务器IP:9995/health` 检查服务。`9995` 是代理端口，`./media_cache` 保存回放缓存；源码默认开启永久保留，无需配置 `CACHE_KEEP_FOREVER`。`MEDIAMTX_BASE` 必须是容器可访问的地址，不能用 `localhost` 指代宿主机。

## 完整 Docker Compose 配置

需要调整缓存、超时和日志时，可使用以下配置：

```yaml
services:
  replay:
    image: ghcr.io/saneslark/mediamtx-replay:latest
    container_name: mediamtx-replay
    restart: unless-stopped
    shm_size: "1g"

    ports:
      - "9995:9995" # 宿主机端口:容器端口

    extra_hosts:
      - "host.docker.internal:host-gateway" # 允许容器访问宿主机

    environment:
      TZ: Asia/Shanghai
      NODE_ENV: production
      PORT: "9995"
      # 默认连接宿主机，也可在 .env 中设置其他服务器地址
      MEDIAMTX_BASE: ${MEDIAMTX_BASE:-http://host.docker.internal:9996}

      CACHE_DIR: /app/proxy/media_cache
      MEMORY_DIR: /dev/shm
      MAX_MEMORY_JOBS: "2"
      CACHE_KEEP_FOREVER: "true" # 默认永久保留；改为 false 后按有效期清理
      CACHE_TTL_DAYS: "90"       # 缓存保留天数
      CLEAN_INT_DAYS: "1"        # 每隔多少天清理一次
      # 可选毫秒配置，启用后覆盖对应的天数配置
      # CACHE_TTL_MS: "7776000000"
      # CLEAN_INTERVAL_MS: "86400000"

      DOWNLOAD_TIMEOUT_MS: "120000" # 下载超时：120 秒
      FFMPEG_TIMEOUT_MS: "60000"    # FFmpeg 处理超时：60 秒
      MAX_DURATION: "3600"         # 单次回放最大时长：3600 秒

    volumes:
      - ./media_cache:/app/proxy/media_cache # 缓存持久化到宿主机

    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

    logging:
      driver: json-file
      options:
        max-size: "50m" # 单个日志文件最大 50 MB
        max-file: "3"   # 最多保留 3 个日志文件
```

保存为 `docker-compose.yml` 后，执行 `docker compose pull` 和 `docker compose up -d`。查看运行状态用 `docker compose ps`，查看日志用 `docker compose logs -f replay`，停止服务用 `docker compose down`；缓存保留在本地 `./media_cache` 目录。

使用上面的默认地址时，宿主机上的 MediaMTX playback 需要监听容器可访问的地址，例如 `:9996`。如果只修改宿主机访问端口，将映射改成 `9994:9995` 即可；如果修改 `PORT` 或 `CACHE_DIR`，需要同步修改端口映射或缓存挂载的容器路径。健康检查只检测代理服务是否可响应。

## 源码与验证

分支只保留回放代理源码、依赖锁文件和 Docker 部署配置。完整服务的 `delay/`、`docker-entrypoint.sh` 和 `mediamtx.example.yml` 已移除。

```bash
cd proxy
npm ci
npm run check
```

`npm run check` 检查代理脚本语法。GitHub Actions 构建镜像时执行语法检查，并在发布前验证容器默认启动命令和 Docker 健康检查；实际回放需连接 MediaMTX playback 验证。
