# 构建 Next.js 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --registry=https://registry.npmmirror.com --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 构建 Go 后端入口。
FROM golang:1.25-alpine AS api-build

WORKDIR /app
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN go build -o /server .

# 运行镜像：Next.js 对外监听 13000，Go 只在容器内部监听 18080。
FROM node:22-bookworm-slim

ARG DEBIAN_MIRROR=http://mirrors.aliyun.com
WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=api-build /server /app/server
COPY --from=web-build /app/web /app/web
ENV PROMPT_DATA_DIR=/app/data/prompts
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i \
            -e "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" \
            -e "s|http://security.debian.org|${DEBIAN_MIRROR}|g" \
            /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
        sed -i \
            -e "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" \
            -e "s|http://security.debian.org|${DEBIAN_MIRROR}|g" \
            /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data/prompts \
    && groupadd -r app && useradd -r -g app app \
    && chown -R app:app /app
USER app

EXPOSE 13000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:13000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
# 先启动内部 Go API，再由 Next.js 提供页面并代理 /api/*；任一进程退出则容器退出，交由编排器重启。
CMD ["bash", "-c", "PORT=18080 /app/server & API_PID=$!; cd /app/web && HOSTNAME=0.0.0.0 PORT=13000 API_BASE_URL=http://127.0.0.1:18080 npm run start & WEB_PID=$!; wait -n; kill $API_PID $WEB_PID 2>/dev/null; exit 1"]
