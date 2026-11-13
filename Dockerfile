# ---- 构建前端静态资源 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 运行 API（Fastify + tsx）----
FROM node:22-alpine AS api
WORKDIR /app
# start 脚本依赖 tsx（devDependency）：NODE_ENV=production 下 npm ci 默认跳过 dev 依赖，必须显式 --include=dev
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
COPY package.json package-lock.json ./
# 安装量较大，加上重试参数，避免镜像构建因一次网络抖动失败
RUN npm ci --include=dev --no-audit --no-fund \
    --fetch-retries=5 --fetch-retry-maxtimeout=120000
COPY tsconfig.json ./
COPY src ./src
EXPOSE 8787
CMD ["npm", "start"]

# ---- 运行前端（nginx，反代 /api）----
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
