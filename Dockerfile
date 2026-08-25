FROM bluenviron/mediamtx:latest AS mediamtx

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        ffmpeg \
        gstreamer1.0-alsa \
        gstreamer1.0-libav \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-ugly \
        gstreamer1.0-rtsp \
        gstreamer1.0-tools \
        nodejs \
        npm \
        python3 \
        python3-gi \
        python3-gst-1.0 \
        python3-yaml \
        tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx

WORKDIR /app

COPY proxy/package*.json ./proxy/
RUN cd proxy && npm ci --omit=dev

COPY proxy/proxy.js ./proxy/proxy.js
COPY delay ./delay
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data/recordings /var/log /app/proxy/media_cache

VOLUME ["/data/recordings", "/app/proxy/media_cache"]

EXPOSE 1935 8554 8888 8889 9995 9996 9997 9998 9999
EXPOSE 8189/udp 8890/udp

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
