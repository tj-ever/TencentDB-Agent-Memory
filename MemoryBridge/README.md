# MemoryBridge · 飞书渠道

MemoryBridge 负责飞书长连接、机器人配置运行时、Claude 会话和消息队列。它通过 MemoryProxy 访问上游模型和腾讯 Mem，面板是唯一的机器人配置入口。

## 运行链路

```text
飞书消息
  -> MemoryBridge:8130
  -> claude -p（工作目录由机器人配置指定）
  -> MemoryProxy:8096/<agent>/<space>/v1/...
  -> 上游 LLM
```

Bridge 为每条请求注入以下上下文：

- `x-team-id`、`x-agent-id`、`x-task-id`：机器人绑定的 Mem 上下文；
- `x-conversation-id`：飞书发送者 `open_id`；
- `x-tdai-user-key`：通过 Claude 的认证环境变量传递给 Proxy。

机器人启动时从 Proxy `GET /v3/config/upstream` 读取模型，优先使用 `claude-code` Agent 模型，其次使用全局模型。接口失败或没有模型时，机器人保持错误状态，不使用本地旧模型。

## 容器部署

镜像基于 Debian Bookworm，内置：

- Claude CLI；
- Debian Chromium 和 Puppeteer；
- `fonts-wqy-zenhei` 中文字体；
- 飞书文档交付所需的基础命令行工具。

截图使用发行版 Chromium，安装依赖时设置 `PUPPETEER_SKIP_DOWNLOAD=1`，不会下载 Chrome for Testing：

```bash
cd deploy/global-images
# .env 中设置 BRIDGE_ENABLED=1 后执行
./start-all.sh

# 或仅启动 Bridge
./start-memory-bridge.sh
```

容器加入 `tdai-memory-stack` 网络，默认通过 `http://tdai-proxy:8096` 访问 Proxy。面板容器默认使用 `http://tdai-memory-bridge:8130` 反代 Bridge。

Bridge 使用三个持久化卷：

| 卷 | 内容 |
| --- | --- |
| `tdai-memory-bridge-data` | `bots.json`、待处理队列和用户映射 |
| `tdai-memory-bridge-workspaces` | 机器人工作目录和交付文件 |
| `tdai-memory-bridge-sessions` | `/home/node/.claude` Claude 会话目录 |

## 本机运行

需要 Node.js 22+、Claude CLI 和可访问的 MemoryProxy：

```bash
cd MemoryBridge
npm install
npm start
```

开发命令：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | tsx watch 开发运行 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | Vitest 单测 |
| `npm run build` | 编译到 `dist/` |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRIDGE_PORT` | `8130` | HTTP 端口 |
| `BRIDGE_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `BRIDGE_DATA_DIR` | `./data` | `bots.json` 和待处理队列目录 |
| `CLAUDE_BIN` | `claude` | Claude CLI 路径 |
| `BRIDGE_PROXY_DEFAULT` | `http://127.0.0.1:8096` | 机器人未填写 Proxy 地址时使用；容器内由镜像设为 `http://tdai-proxy:8096` |
| `BRIDGE_USER_KEY_DEFAULT` | 空 | 机器人未填写 Mem user key 时使用 |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium`（容器） | 截图浏览器路径 |

## 机器人配置

配置保存在 `BRIDGE_DATA_DIR/bots.json`，推荐通过面板“组织与权限 → 飞书机器人”维护。

- `memory.proxy_base_url`、`memory.space_id`、`memory.user_key`：Proxy 访问和 Mem 身份；
- `binding.team_id`、`binding.agent_id`、`binding.task_id`：记忆绑定；
- `feishu.app_id`、`feishu.app_secret`、`feishu.policy`：飞书连接和消息策略；
- `session_mode`：`none`、`user`、`chat`；
- `system_prompt`：机器人专用 system prompt。

密钥只在创建或更新时写入，列表和详情接口返回脱敏值。提交已显示的掩码表示保持已有密钥。

## HTTP API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/bots?team_id=` | 查询机器人 |
| `GET` | `/api/bots/:id` | 查询单个机器人 |
| `POST` | `/api/bots` | 创建机器人 |
| `PUT` | `/api/bots/:id` | 更新机器人 |
| `DELETE` | `/api/bots/:id` | 删除机器人 |
| `POST` | `/api/bots/:id/start`、`/stop` | 启停机器人 |
| `GET` | `/api/bots/:id/sessions` | 查询队列和 Claude 会话 |
| `POST` | `/api/bots/:id/abort` | 中止当前任务 |
| `POST` | `/api/bots/:id/sessions/:sid/clear` | 删除会话文件 |

## 持久化行为

每个机器人使用 `data/pending/<bot-id>.jsonl` 保存待处理消息。消息完成后从队列移除，进程重启后继续消费队列。`session_mode=user` 或 `chat` 时，Claude 会话文件保存在对应项目目录，面板可查询并清理。

当 Proxy 的 `supportsImages` 为 `false` 时，Bridge 对图片消息返回文字提示；图片不会发送给文本模型。

## 安全边界

- 机器人工作目录是 Claude 文件访问范围。
- 飞书 app secret 和 Mem user key 不写入日志或列表响应。
- Proxy 自定义 Agent 的 Mem binding 由 Proxy 校验 Team active member。
- Bridge 的 HTTP API 建议仅在内部网络暴露，由 MemoryPanel 负责面板侧鉴权。
