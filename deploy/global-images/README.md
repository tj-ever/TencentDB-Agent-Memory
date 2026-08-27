# TDAI 全局镜像本地部署

本目录提供 `memory-core`、`memory-hub`、`proxy` 和可选 `memory-bridge` 的本地 Docker 启动脚本。

## 组件

| 组件 | 容器 | 端口 | 作用 |
| --- | --- | --- | --- |
| memory-core | `tdai-memory-core` | `8420` | Gateway、记忆、Skill、鉴权和元数据 |
| memory-hub | `tdai-memory-hub` | `8125` / `8424` | Panel 和 Knowledge |
| proxy | `tdai-proxy` | `8096` | LLM 请求代理、Mem 注入和用量上报 |
| memory-bridge | `tdai-memory-bridge` | `8130` | 可选飞书机器人渠道 |

## 环境准备

需要 Docker 和 Bash。先准备环境文件：

```bash
cd deploy/global-images

# 一条命令：自动复制 .env → 交互式填 LLM → 自动校验通路 → 拉起三件套
./start-all.sh
```

`start-all.sh` 是**交互式**的，运行时会：

1. `.env` 不存在时，自动从 `.env.example` 复制一份（无需手动 `cp`）
2. 引导你填写两组 LLM（**回车 = 保留当前默认值**）：
   - `memory 组`：`BASE_URL` / `API_KEY` / `MODEL`（协议默认 `openai`）
   - `proxy 组`：先问「是否复用 memory 组配置」，复用则跳过
3. 填完**立即检查 LLM 通路是否通**，不通会提示重新输入，直到通过
4. 把填写值**写回 `.env`** 持久化（下次启动默认复用）
5. 通过后一键拉起三件套

> 想跳过交互、直接读 `.env` 也可以：手动 `cp .env.example .env` 并填好 LLM 后，
> 运行 `./start-all.sh` 一路回车确认即可（默认值就是 `.env` 里的值）。
> 设置 `BRIDGE_ENABLED=1` 时会在三件套之后追加启动第 4 个容器 memory-bridge（飞书机器人）。

### 干跑校验（可选）

`verify.sh` 仍可单独使用，只检查环境不启动容器：

```bash
./verify.sh              # 默认全检（含 LLM 通路预检）
./verify.sh --skip-llm   # 跳过 LLM 检查（离线环境）
```

## LLM 通路预检

| 变量 | 用途 |
| --- | --- |
| `MEMORY_LLM_BASE_URL` | memory 服务默认 LLM 地址 |
| `MEMORY_LLM_API_KEY` | memory 服务默认 LLM 凭据 |
| `MEMORY_LLM_MODEL` | memory 服务默认模型 |
| `PROXY_UPSTREAM_URL` | Proxy 全局上游地址 |
| `PROXY_UPSTREAM_API_KEY` | Proxy 全局上游凭据 |
| `PROXY_UPSTREAM_MODEL` | Proxy 全局上游模型 |
| `KNOWLEDGE_PUBLIC_BASE_URL` | Knowledge 对外 tools 地址 |

端口、镜像和数据卷可在 `.env` 中覆盖。真实密钥只保存在本地 `.env`，不要提交到 Git。

## 启动和停止

```bash
./verify.sh                 # 校验配置和 LLM 通路
./verify.sh --skip-llm      # 仅做离线校验
./start-all.sh              # memory-core -> memory-hub -> proxy
BRIDGE_ENABLED=1 ./start-all.sh
./stop-all.sh
./stop-all.sh --purge       # 同时删除本地数据卷
```

也可以单独执行：

```bash
./start-memory-core.sh
./start-memory-hub.sh
./start-proxy.sh
./start-memory-bridge.sh
```

启动完成后：

- Panel：`http://localhost:8125/`
- Knowledge：`http://localhost:8424/`
- Memory Gateway：`http://localhost:8420/`
- Proxy：`http://localhost:8096/`
- Bridge：`http://localhost:8130/`

## LLM 配置关系

### Proxy 上游

Proxy 主配置由 `start-proxy.sh` 根据以下变量生成：

- `PROXY_UPSTREAM_URL`
- `PROXY_UPSTREAM_API_KEY`
- `PROXY_UPSTREAM_MODEL`

面板“系统 → 系统配置”通过 Proxy `/v3/config/upstream` 读取和更新全局上游及 Agent 上游。运行期更新写入 `config.override.yaml`，主配置文件保持只读。

### Knowledge 和机器人

默认 `start-memory-hub.sh` 使用：

- `LLM_MODE=proxy`
- `KNOWLEDGE_LLM_BINDING_SYNC=1`
- `KNOWLEDGE_LLM_PROXY_BASE_URL=http://tdai-proxy:8096/claude-code/default/v1`

Knowledge 通过 Proxy 的 `knowledge-service` system user 调用 LLM，因此机器人和 Knowledge 默认共用面板中的 Proxy 上游。`MEMORY_LLM_BASE_URL`、`MEMORY_LLM_API_KEY`、`MEMORY_LLM_MODEL` 仍用于 memory-hub 启动校验和知识服务默认参数。

## MemoryBridge

设置 `BRIDGE_ENABLED=1` 后，`start-all.sh` 会构建并启动 Bridge 镜像。Bridge 镜像内置 Claude CLI、Debian Chromium 和中文字体，容器内 Proxy 地址为 `http://tdai-proxy:8096`。

配置入口为 Panel“组织与权限 → 飞书机器人”。持久化卷：

| 卷 | 内容 |
| --- | --- |
| `tdai-memory-bridge-data` | 机器人配置和待处理队列 |
| `tdai-memory-bridge-workspaces` | 机器人工作目录 |
| `tdai-memory-bridge-sessions` | Claude 会话目录 |

## 网络和持久化

所有容器加入 `tdai-memory-stack` Docker 网络。Proxy 主配置挂载到 `/data/config.yaml:ro`，运行期 override 挂载到 `/data/runtime-config:rw`，环境变量 `PROXY_OVERRIDE_CONFIG` 指向 override 文件。

默认数据卷：

- `MEMORY_CORE_VOLUME`：memory-core 数据；
- `PANEL_VOLUME`：Panel 和 Knowledge 数据；
- `PROXY_VOLUME`：Proxy 存储和会话数据。

## Proxy 客户端地址

编码 Agent 将 API base 指向宿主机的 Proxy：

```text
http://127.0.0.1:8096/claude-code/default
http://127.0.0.1:8096/codex/default
```

面板客户端接入地址由 `MEMORY_HUB_PROXY_PUBLIC_URL` 控制；未设置时脚本自动使用宿主机可达地址。

## 配置安全

- 非本机部署时启用 Proxy auth，并限制 8096、8125、8130 的网络访问。
- `MEMORY_CORE_ADMIN_USERNAME` 和 `.admin-key` 用于本地管理员身份；不要把 `.admin-key` 放入仓库。
- `PROXY_UPSTREAM_API_KEY`、`MEMORY_LLM_API_KEY`、Bridge 的飞书凭据和 Mem user key 仅通过环境变量或面板密钥字段注入。
- 停止容器不会删除卷；需要清理数据时显式使用 `./stop-all.sh --purge`。

## 常用排查

```bash
docker ps
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
docker logs -f tdai-memory-bridge
curl http://127.0.0.1:8096/health
curl http://127.0.0.1:8130/health
```
