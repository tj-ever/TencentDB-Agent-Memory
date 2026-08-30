# AI交付协同平台 二开说明

本文描述当前工作区中 MemoryBridge、MemoryPanel 和 MemoryProxy 的飞书机器人及自定义上游能力。

## 系统定位

MemoryBridge 是飞书长连接运行服务。它从面板读取机器人配置，接收私聊或群聊消息，调用本机 `claude -p`，再通过 MemoryProxy 访问大模型和腾讯 Mem。

MemoryPanel 是配置入口和权限边界，负责代理机器人管理接口及 Proxy 上游配置接口。MemoryProxy 负责上游路由、Mem 注入、会话初始化、鉴权、图片策略和用量上报。MemoryCore 负责记忆、Skill、Team、Agent、Task 和 Knowledge 数据。

## 当前数据流

```text
飞书用户
  -> MemoryBridge:8130
  -> claude -p（工作目录和会话目录由 Bridge 管理）
  -> MemoryProxy:8096/<agent>/<space>/v1/...
  -> 上游 LLM

MemoryProxy -> MemoryCore:8420（鉴权、记忆、Skill、Team/Agent/Task）
MemoryPanel:8125 -> MemoryBridge HTTP API
MemoryPanel:8125 -> MemoryProxy /v3/config/upstream
MemoryPanel:8125 -> MemoryCore（面板自身业务）
```

飞书消息的会话标识使用发送者 `open_id`，因此同一个机器人按用户隔离对话记忆。机器人绑定的 `team_id`、`agent_id`、`task_id` 作为 Mem 上下文注入请求头。

## MemoryBridge

### 运行职责

- 维护 `enabled` 机器人的飞书长连接。
- 按机器人 `work_dir` 启动 `claude -p`，使用 `stream-json` 将增量文本回传为飞书打字机卡片。
- 将 `x-team-id`、`x-agent-id`、`x-task-id`、`x-conversation-id` 和 Mem user key 传给 Proxy。
- 从 Proxy `/v3/config/upstream` 读取模型；优先使用 `claude-code` Agent 模型，其次使用全局模型。没有模型或接口不可用时，机器人启动失败。
- 当上游 `supportsImages=false` 时拒绝图片消息，避免文本模型收到图片内容块。
- 使用持久化消息队列和 Claude 会话文件，进程重启后继续处理未完成消息。
- 识别飞书文档链接并按机器人凭据处理可访问权限。

### 配置文件和目录

机器人配置保存在 `BRIDGE_DATA_DIR/bots.json`。密钥只在写入时提交，HTTP 返回值始终脱敏。

| 字段 | 说明 |
| --- | --- |
| `name` | 机器人显示名和默认提示词中的名称 |
| `work_dir` | Claude 工作目录，容器内建议使用 `/app/workspaces/<name>` |
| `enabled` | Bridge 启动时是否自动连接飞书 |
| `memory.proxy_base_url` | Proxy 地址；留空使用 `BRIDGE_PROXY_DEFAULT` |
| `memory.space_id` | Mem 实例标识，默认 `default` |
| `memory.user_key` | Proxy/Mem 用户凭据；未填写时使用 `BRIDGE_USER_KEY_DEFAULT` |
| `binding.team_id` / `agent_id` / `task_id` | 记忆上下文绑定 |
| `feishu.app_id` / `app_secret` | 飞书应用凭据 |
| `feishu.policy` | `requireMention`、`dmMode`、可选私聊白名单 |
| `session_mode` | `none`、`user` 或 `chat` |
| `system_prompt` | 机器人专用 system prompt；为空时使用 `config/zhuoyu.system.md` 通用规则 |

Bridge 的运行数据包括：

- `pending/<bot-id>.jsonl`：待处理消息队列；
- Claude 项目目录下的 `.jsonl`：会话记录；
- `sessionUsers.json`：会话与飞书用户名称映射。

### Bridge HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康检查 |
| `GET` | `/api/bots?team_id=` | 查询机器人列表 |
| `GET` | `/api/bots/:id` | 查询机器人详情 |
| `POST` | `/api/bots` | 创建机器人 |
| `PUT` | `/api/bots/:id` | 更新机器人 |
| `DELETE` | `/api/bots/:id` | 删除机器人并停止运行 |
| `POST` | `/api/bots/:id/start` | 启动机器人 |
| `POST` | `/api/bots/:id/stop` | 停止机器人 |
| `GET` | `/api/bots/:id/sessions` | 查询运行态、队列和会话文件 |
| `POST` | `/api/bots/:id/abort` | 中止当前任务 |
| `POST` | `/api/bots/:id/sessions/:sid/clear` | 删除指定会话 |

密钥只在创建或更新时写入，列表和详情接口返回脱敏值。更新时提交已显示的掩码表示保持原值。

### Bridge 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRIDGE_PORT` | `8130` | HTTP 监听端口 |
| `BRIDGE_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `BRIDGE_DATA_DIR` | `./data` | 配置和队列目录 |
| `CLAUDE_BIN` | `claude` | Claude CLI 可执行文件 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 内置值 | Claude 上下文自动压缩窗口 |
| `CLAUDE_CODE_MAX_RETRIES` | 内置值 | Claude 调用最大重试次数 |
| `BRIDGE_PROXY_DEFAULT` | `http://127.0.0.1:8096` | 机器人未配置 Proxy 时使用 |
| `BRIDGE_USER_KEY_DEFAULT` | 空 | 机器人未配置 user key 时使用 |
| `BRIDGE_ADMIN_TOKEN` | 空（无鉴权+告警） | 管理 API 门禁：设置后除 `/health` 外全部要求 `x-bridge-token` 匹配。`start-memory-bridge.sh` 自动生成 `.bridge-token` 并注入 bridge 容器；面板经 `MEMORY_BRIDGE_TOKEN` 携带同一 token |

## MemoryPanel

### 页面

- **组织与权限 → 飞书机器人**：管理机器人配置、启动/停止、队列和会话。
- **系统 → 系统配置**：管理 Proxy 全局上游和 Agent 上游。

页面使用的面板接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET/POST/PUT/DELETE` | `/api/v1/channels`、`/api/v1/channels/:id` | 反代 Bridge 机器人接口 |
| `POST` | `/api/v1/channels/:id/start`、`/stop` | 控制机器人 |
| `GET` | `/api/v1/channels/:id/sessions` | 查询会话和队列 |
| `POST` | `/api/v1/channels/:id/abort` | 中止任务 |
| `POST` | `/api/v1/channels/:id/sessions/:sid/clear` | 清理会话 |
| `GET/PUT` | `/api/v1/proxy-config` | 读取/更新 Proxy 上游 |

面板通过 `panelMeta` 校验调用者身份。Proxy 上游读写仅允许 MemoryCore 验证出的 `system_admin` 用户。

## MemoryProxy

### 上游路由

Proxy 的全局上游由 `upstream.url`、`upstream.apiKey`、`upstream.model` 和 `upstream.supportsImages` 定义。`upstream.agents` 可按 URL 前缀配置独立的 URL、模型和 Mem binding。

**Key 分离语义**：命中 agent 配置时，模型 Key 一律由调用方透传，proxy 不配置/替换任何 agent 级 Key。记忆身份通过独立的 `x-tdai-user-key` 请求头携带。

当前路由示例：

```text
/proxy/<space>/v1/...
/claude-code/<space>/v1/...
/fw1/<space>/v1/...
```

内置 Agent：`claude-code`、`codebuddy`、`codex`、`cursor`、`hermes`、`openclaw`、`workbuddy`、`dsh`、`opencode`。内置 Agent 和已配置 Agent 使用第二段作为 `space_id`；自定义 Agent（例如 `fw1`）使用其配置的 URL 和模型。

Agent 配置了 `binding.team_id` 和 `binding.agent_id` 时，Proxy 会先调用 MemoryCore 校验调用者是否为该 Team 的 active member（使用 `x-tdai-user-key` 作为记忆身份）；校验通过后将 binding 作为可信会话上下文。

前置认证（路由解析 → 记忆身份解析 → `verifyUserKey` → binding 授权）收敛在 `MemoryProxy/src/custom/upstream.ts` 的 `earlyAuth()` 门面中，`handler.ts` 与 `anthropicHandler.ts` 调用同一入口。

### 运行期上游配置

- `GET /v3/config/upstream`：需要有效的 `x-tdai-service-id` 和 `x-tdai-user-key`。
- `PUT /v3/config/upstream`：额外要求已启用鉴权且调用者为 `system_admin`。
- 返回值对 API key 脱敏；更新以原子方式写入 `PROXY_OVERRIDE_CONFIG` 指向的文件。
- 主配置文件可以只读挂载，运行期变更持久化在 override 文件中。

请求体中的模型由 Agent 模型覆盖全局模型；模型名末尾的 `[...]` 计费标记在转发前移除。`supportsImages=false` 时只处理 Anthropic/OpenAI 明确的消息内容块并剥离图片块，不扫描无关字段。

## 部署

`deploy/global-images/start-all.sh` 按顺序启动 `memory-core`、`memory-hub`、`proxy`；设置 `BRIDGE_ENABLED=1` 时再启动 `memory-bridge`。

默认关系如下：

- `memory-hub` 以 `LLM_MODE=proxy` 运行；Knowledge 通过 `http://tdai-proxy:8096/claude-code/default/v1` 和 `knowledge-service` system user 访问 Proxy。
- 机器人和 Knowledge 默认共用 Proxy 面板中的上游配置。
- `MEMORY_LLM_BASE_URL`、`MEMORY_LLM_API_KEY`、`MEMORY_LLM_MODEL` 仍作为 memory-hub 启动校验和知识服务默认参数。
- `PROXY_UPSTREAM_URL`、`PROXY_UPSTREAM_API_KEY`、`PROXY_UPSTREAM_MODEL` 生成 Proxy 主配置。
- `LLM_CHECK_WARN_ONLY=1`：跳过 `_lib.sh` 的交互式 LLM 配置与硬性通路预检，仅警告不阻断（适用于 `host.docker.internal` 等宿主机测不通但容器内可通的部署形态）。

Bridge 容器使用以下持久化卷：

| 卷 | 内容 |
| --- | --- |
| `tdai-memory-bridge-data` | `bots.json`、待处理队列、会话用户映射 |
| `tdai-memory-bridge-workspaces` | 机器人工作目录和交付文件 |
| `tdai-memory-bridge-sessions` | `/home/node/.claude` Claude 会话目录 |

镜像构建约定（四个 Dockerfile + `deploy/panel-knowledge-combined/build.sh` 统一）：

- npm cache mount 统一使用 `id=shared-npm-cache`，跨镜像复用下载缓存。
- 构建参数 `--build-arg NPM_REGISTRY=<url>` 指定 npm 源；Dockerfile 默认官方源，`build.sh` 默认 `https://registry.npmmirror.com`，均可显式覆盖。
- 有 lock 文件的构建使用 `npm ci` 直装。

常用命令：

```bash
cd deploy/global-images
cp .env.example .env
./start-all.sh
./stop-all.sh
./start-memory-bridge.sh
```

## CI

`.github/workflows/pr-ci.yml` 在官方 CI 之外新增 `custom-code` job，PR 到 `main` 时运行：

- MemoryBridge：`typecheck` + `test`（零错误，硬门禁）。
- MemoryProxy：typecheck 错误数门禁，基线 55（上游 v2.0.1 发版即存在），超过基线即失败。
- MemoryPanel web：`typecheck`（零错误，硬门禁）。

## 二开代码布局：隔离目录与散改清单

二开遵循「新功能进 `custom/` 隔离目录，最小化散改官方文件」的原则。

### 隔离目录（上游不存在，合并零冲突）

| 目录 | 内容 |
| --- | --- |
| `MemoryBridge/` | 整个子项目（含 `config/zhuoyu.system.md` 业务提示词） |
| `MemoryProxy/src/custom/` | 上游路由解析（upstream.ts，含 `earlyAuth()`、`trustedPreset()`）、服务端 binding 直通（session-preset.ts）、请求体处理（request-body.ts）、`/v3/config/upstream` 路由（routes/upstream-config.ts）、测试 |
| `MemoryPanel/src/panel/custom/` | 面板反代 Bridge 的 channels 路由、Proxy 上游配置路由、统一注册点 index.ts |
| `MemoryPanel/web/src/custom/` | 前端机器人管理 API、会话管理组件、系统配置页 |
| `MemoryPanel/web/src/pages/team/ChannelsPage/` | 机器人管理页面 |

### 散改的官方文件（合并时需要逐一核对）

| 文件 | 改动内容 |
| --- | --- |
| `MemoryProxy/src/handler.ts`、`anthropicHandler.ts` | 调用 `custom/upstream.ts` 的 `earlyAuth()` 统一前置认证；anthropicHandler 仅保留 `trustedPreset` |
| `MemoryProxy/src/server.ts` | 注册 `/v3/config/upstream` GET/PUT |
| `MemoryProxy/src/session/index.ts` | Anthropic 协议一律走 claude-code 状态机 + serverPreset 直注册 |
| `MemoryProxy/src/types.ts` | Key 分离语义（agent 级 apiKey 已移除） |
| `MemoryProxy/src/auth.ts`、`systemUserPassthrough.ts`、`config.ts`、`codexHandler.ts`、`workbuddyHandler.ts`、`auxiliaryHandler.ts`、`credit-reporter.ts`、`session/claude-code/init.ts` | 配合 Key 分离、记忆身份与内置 Agent 名单（`isBuiltinAgent()`）的小幅适配 |
| `MemoryProxy/config.example.yaml` | 上游配置示例（agents 映射无 apiKey） |
| `MemoryPanel/src/panel/http/app.ts` | 注册 `registerCustomRoutes`（一行） |
| `MemoryPanel/src/panel/config/panel-config.ts` | `bridge.baseUrl` 与 `proxy.baseUrl/publicUrl` 配置段 |
| `MemoryPanel/web/`（LoginGate、i18n、ConsoleLayout、GlobalHeader、routes、menu 等） | 品牌名「AI交付智协平台」+ 菜单/路由接入机器人管理与系统配置页 |
| `MemoryBridge/`、`MemoryCore/`、`MemoryProxy/`、`deploy/panel-knowledge-combined/` 的 Dockerfile | npm cache mount 统一 `shared-npm-cache`、`NPM_REGISTRY` build-arg、`npm ci` |
| `.github/workflows/pr-ci.yml` | `custom-code` job（见 CI 节） |
| `deploy/global-images/*.sh`、`_lib.sh`、`.env.example` | bridge 容器编排 + `LLM_CHECK_WARN_ONLY` 预检跳过 |

## 升级上游版本的合并要点

1. 合并前提交或 stash 本地全部改动；在集成分支上执行 `git merge <upstream-tag>`，不直接在 `custom/main` 上试错。
2. 冲突解决原则：**保官方功能逻辑，重新套用二开**。隔离目录不会冲突；散改文件需先看官方改了什么，再把对应二开意图（见上表）重新落到新代码上。
3. 重点核对散改热区是否被官方重构吞掉：
   - `handler.ts` / `anthropicHandler.ts`：`earlyAuth()` 调用是否还需要挂在新逻辑上；
   - `session/index.ts`：Anthropic→claude-code 状态机的强制路由 + serverPreset 参数；
   - `panel-config.ts` 的 `bridge`/`proxy` 段与 `app.ts` 的 `registerCustomRoutes` 注册行；
   - `web/` 菜单（`PageId` 联合类型的自定义项）、路由、i18n 自定义文案；
   - `deploy/global-images/*.sh` 的 `_lib.sh` 结构中 bridge 启停与 `LLM_CHECK_WARN_ONLY`；
   - 四个 Dockerfile 的 cache mount id 与 `NPM_REGISTRY` 参数；
   - `pr-ci.yml` 的 `custom-code` job 与 MemoryProxy 错误数基线。
4. `MemoryBridge/` 为独立目录，无合并冲突风险；只需确认 Dockerfile/deploy 脚本引用路径未失效。
5. 合并后必须全量跑「当前检查命令」（CI `custom-code` job 即其自动化形态），并人工回归机器人启停与 `/v3/config/upstream` 面板读写。

## 安全约束

- API key、飞书 app secret、Mem user key 只通过环境变量或面板密钥字段提供，不提交到 Git。
- Bridge 的机器人工作目录是文件访问边界；默认提示词禁止读取其他项目目录。
- 自定义 Agent binding 必须经过 Team active member 校验。
- Proxy 运维配置接口只接受 system admin。
- 非本机部署时启用 Proxy auth，并限制 Panel、Bridge 和 Proxy 的网络访问范围。

## 当前检查命令

```bash
cd MemoryBridge
npm run typecheck
npm test

cd ../MemoryPanel/web
npm run typecheck

cd ../..
bash -n deploy/global-images/start-all.sh \
  deploy/global-images/start-memory-bridge.sh \
  deploy/global-images/start-memory-hub.sh \
  deploy/global-images/start-proxy.sh \
  deploy/global-images/stop-all.sh
git diff --check
```

MemoryProxy 的 typecheck 有 55 个上游自带错误（v2.0.1 发版即存在），不作为门禁，CI 以错误数不超基线为准。
