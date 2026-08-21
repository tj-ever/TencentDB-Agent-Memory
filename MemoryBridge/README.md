# MemoryBridge · 飞书渠道

把腾讯 Mem 接到飞书：长连接收消息 → `claude -p`（带 `x-team-id / x-agent-id / x-task-id / x-conversation-id`）→ 打字机回飞书。

配置在 **8125 面板 → 组织与权限 → 飞书机器人**，本服务只负责运行时。

## 容器部署（推荐，零宿主机依赖）

镜像自包含：claude CLI + chrome-headless-shell 截图内核 + 最小中文字体（wqy-zenhei），
与三件套同跑在 `tdai-memory-stack` 网络，不依赖宿主机任何环境：

```bash
cd deploy/global-images
# .env 里 BRIDGE_ENABLED=1 后 ./start-all.sh 会自动带起；或单独：
./start-memory-bridge.sh          # 构建镜像 + 启动 tdai-memory-bridge，加入 docker 网络
```

三个 volume：`data`（bots.json 配置）、`workspaces`（机器人工作目录）、`sessions`（claude 会话，容器重启续聊不丢）。
容器内 proxy 地址默认 `http://tdai-proxy:8096`（机器人表单留空即用此默认）。

## 本机直跑（开发调试）

```bash
cd MemoryBridge
npm install
npm start          # :8130
```

TypeScript（与仓库 MemoryPanel 同栈：ESM + strict + tsx + vitest）：

| 命令 | 说明 |
|------|------|
| `npm start` | tsx 直跑 `src/index.ts` |
| `npm run dev` | tsx watch 热重载 |
| `npm run build` / `npm run typecheck` | tsc 编译到 `dist/` / 仅类型检查 |
| `npm test` | vitest 单测 |

环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BRIDGE_PORT` | `8130` | HTTP API |
| `BRIDGE_DATA_DIR` | `./data` | `bots.json` |
| `CLAUDE_BIN` | `claude` | claude CLI（容器镜像内已内置，本机跑时需自装） |
| `BRIDGE_PROXY_DEFAULT` | `127.0.0.1:8096` | 机器人未填 proxy 地址时的兜底（容器镜像内置 `http://tdai-proxy:8096`） |
| `BRIDGE_HOST` | `0.0.0.0` | HTTP 监听地址 |

原型截图（`scripts/embed-prototype.mjs`）依赖 puppeteer 自带 Chromium，`npm install` 时自动下载；推荐跳过完整版 Chrome、只装截图内核（约 100MB）：

```bash
PUPPETEER_SKIP_CHROME_DOWNLOAD=1 npm install
```

面板通过 `MEMORY_BRIDGE_URL` 反代本 API：容器部署默认 `http://tdai-memory-bridge:8130`（start-memory-hub.sh 注入），本机直跑默认 `http://127.0.0.1:8130`。

## API

- `GET /health`
- `GET /api/bots?team_id=`
- `POST /api/bots`
- `PUT /api/bots/:id`
- `DELETE /api/bots/:id`
- `POST /api/bots/:id/start`
- `POST /api/bots/:id/stop`

密钥只在创建/更新时写入，列表接口脱敏。

## 和官方三件套的关系

```
飞书 → MemoryBridge:8130 → claude -p → MemoryProxy:8096/claude-code/<space> → Core
面板 8125 ──proxy──┘
```

`enabled=true` 的机器人在进程启动时自动拉起长连接。
