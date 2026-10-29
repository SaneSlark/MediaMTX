FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=9995 \
    CACHE_DIR=/app/proxy/media_cache \
    MEMORY_DIR=/dev/shm

RUN apk add --no-cache ca-certificates ffmpeg tini

WORKDIR /app/proxy

COPY proxy/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY proxy/replay-proxy.js ./replay-proxy.js
RUN npm run check && mkdir -p /app/proxy/media_cache

VOLUME ["/app/proxy/media_cache"]
EXPOSE 9995

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["node", "replay-proxy.js"]
