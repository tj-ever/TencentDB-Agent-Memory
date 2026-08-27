# MemoryBridge · 飞书机器人渠道（自包含镜像，零宿主机依赖）
#
# 构建：  docker build -t tdai-memory-bridge:local .
# 运行：  deploy/global-images/start-memory-bridge.sh
#
# 镜像内置：
#   - claude CLI（@anthropic-ai/claude-code，认证走 proxy token，无需登录）
#   - 截图内核用发行版 chromium（Chrome-for-Testing 无 linux/arm64 构建，
#     Debian chromium 原生双架构，经 PUPPETEER_EXECUTABLE_PATH 指定）
#   - 最小中文字体 fonts-wqy-zenhei（~9MB；不装 noto 全量，原型文字能渲染即可）
FROM node:22-bookworm-slim

# Claude 执行代码与飞书交付所需的最小工具集。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-wqy-zenhei \
    curl git jq \
    ripgrep \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# claude CLI：容器内 headless 执行 claude -p
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
# PUPPETEER_SKIP_DOWNLOAD=1：截图用发行版 chromium，不下载 Chrome-for-Testing
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts

ENV CLAUDE_BIN=/usr/local/bin/claude \
    BRIDGE_DATA_DIR=/app/data \
    BRIDGE_PROXY_DEFAULT=http://tdai-proxy:8096 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production
EXPOSE 8130

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8130/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 非 root 运行：claude 2.1.237 禁止在 root 下使用 --dangerously-skip-permissions。
# 用镜像自带 node 用户（uid 1000）。挂载卷（data/workspaces/sessions）的属主
# 由 start-memory-bridge.sh 在启动前 chown 给 1000，保证可写。
RUN chown -R node:node /app
ENV HOME=/home/node
USER node

CMD ["npm", "start"]
