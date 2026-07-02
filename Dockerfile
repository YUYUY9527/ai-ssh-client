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

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY --from=build /app/dist/renderer ./dist/renderer

EXPOSE 5080

CMD ["node", "server/index.cjs"]
