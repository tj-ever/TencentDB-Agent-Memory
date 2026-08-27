#!/usr/bin/env bash
# 单独拉起 MemoryBridge（飞书机器人渠道，端口 8130）。
#
# 与三件套同网络（tdai-memory-stack）：bridge -> tdai-proxy:8096，
# 面板容器通过 http://tdai-memory-bridge:8130 反代（start-memory-hub.sh 注入）。
#
# 镜像本地构建（无公网镜像），代码变更后重跑本脚本即可重建。
# 用法：
#   ./start-memory-bridge.sh
#   SKIP_BUILD=1 ./start-memory-bridge.sh   # 不重建镜像，直接用本地已有的

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env

CONTAINER=tdai-memory-bridge
NETWORK=tdai-memory-stack
BRIDGE_IMAGE="${BRIDGE_IMAGE:-tdai-memory-bridge:local}"
BRIDGE_PORT="${BRIDGE_PORT:-8130}"
BRIDGE_DATA_VOLUME="${BRIDGE_DATA_VOLUME:-tdai-memory-bridge-data}"
BRIDGE_WORKSPACES_VOLUME="${BRIDGE_WORKSPACES_VOLUME:-tdai-memory-bridge-workspaces}"
BRIDGE_SESSIONS_VOLUME="${BRIDGE_SESSIONS_VOLUME:-tdai-memory-bridge-sessions}"

# 新部署默认复用 memory-core 初始化生成的管理员 user_key；显式环境变量优先。
if [[ -z "${BRIDGE_USER_KEY_DEFAULT:-}" ]]; then
  ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
  if [[ -s "$ADMIN_KEY_FILE" ]]; then
    BRIDGE_USER_KEY_DEFAULT="$(<"$ADMIN_KEY_FILE")"
  else
    die "缺少 BRIDGE_USER_KEY_DEFAULT，且未找到 ${ADMIN_KEY_FILE}。请先启动 memory-core 或显式配置该变量。"
  fi
fi

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# 依赖检查（不阻塞，仅提醒）
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-proxy"; then
  warn "tdai-proxy 容器未运行，机器人的 claude -p 将无法连到记忆 proxy。"
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  info "构建镜像 ${BRIDGE_IMAGE}（首次较慢：安装 claude CLI + Chromium）"
  $DOCKER build -t "$BRIDGE_IMAGE" "$SCRIPT_DIR/../../MemoryBridge" || die "构建 $BRIDGE_IMAGE 失败。"
fi

rm_container_if_exists "$CONTAINER"

# 容器以非 root（node:1000）运行：把挂载卷属主统一为 1000，保证可写。
info "确保数据卷属主为 node(uid 1000)…"
$DOCKER run --rm \
  -v "${BRIDGE_DATA_VOLUME}:/v1" \
  -v "${BRIDGE_WORKSPACES_VOLUME}:/v2" \
  -v "${BRIDGE_SESSIONS_VOLUME}:/v3" \
  alpine chown -R 1000:1000 /v1 /v2 /v3

info "启动 $CONTAINER (port=$BRIDGE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-bridge \
  --add-host=host.docker.internal:host-gateway \
  --restart unless-stopped \
  -p "${BRIDGE_PORT}:8130" \
  -v "${BRIDGE_DATA_VOLUME}:/app/data" \
  -v "${BRIDGE_WORKSPACES_VOLUME}:/app/workspaces" \
  -v "${BRIDGE_SESSIONS_VOLUME}:/home/node/.claude" \
  -e BRIDGE_USER_KEY_DEFAULT="$BRIDGE_USER_KEY_DEFAULT" \
  "$BRIDGE_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "memory-bridge 已启动"
ok "  Health   -> http://localhost:${BRIDGE_PORT}/health"
ok "  面板入口 -> http://localhost:${PANEL_PORT:-8125}/ → 组织与权限 → 飞书机器人"
ok "  查看日志 -> docker logs -f $CONTAINER"
