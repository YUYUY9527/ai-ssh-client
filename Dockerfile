FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:renderer

FROM node:20-bookworm-slim

WORKDIR /app

ENV DATA_DIR=/data
ENV WEB_PORT=5080

# openssl：WEB_TLS=1 时首次启动自动生成自签名证书（浏览器安全策略要求 HTTPS 才允许下载非白名单文件）
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY --from=build /app/dist/renderer ./dist/renderer

EXPOSE 5080

CMD ["node", "server/index.cjs"]
