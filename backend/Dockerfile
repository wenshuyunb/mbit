# =============================================================================
# SoulMap AI 后端镜像（多阶段构建）
# -----------------------------------------------------------------------------
# 构建：docker build -t soulmap/server:local ./backend
# 运行：
#   API    → node dist/main.js
#   Worker → node dist/worker.js   （与 API 同镜像）
#
# 安全与体积要求：
#   · 运行层不包含源码、devDependencies、pnpm store
#   · 以非 root 用户 node 运行
#   · 生产依赖使用 --prod 单独安装，避免把测试框架带进生产
# =============================================================================

# ------------------------------------------------------------------ 依赖安装层
FROM node:20-alpine AS deps

WORKDIR /app

# 仅复制清单文件，最大化利用 Docker 层缓存
COPY package.json ./

# 项目在 pnpm workspace 中，独立镜像构建时使用 npm 安装（锁文件由 CI 统一管理）
RUN npm install --no-audit --no-fund --ignore-scripts

# -------------------------------------------------------------------- 构建层
FROM node:20-alpine AS builder

WORKDIR /app

ENV NODE_ENV=development

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 生成 Prisma Client 需要 schema 存在；无模型时也能成功生成
RUN npx prisma generate --schema=./prisma/schema.prisma

RUN npm run build

# 剔除 devDependencies，仅保留运行期依赖
RUN npm prune --omit=dev

# -------------------------------------------------------------------- 运行层
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3000

# 容器内健康检查与调试所需的极小工具集
RUN apk add --no-cache wget tini

# 以非 root 运行
USER node

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json

EXPOSE 3000

# tini 作为 init 进程，正确转发信号，保证优雅关闭生效
ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1

CMD ["node", "dist/main.js"]
