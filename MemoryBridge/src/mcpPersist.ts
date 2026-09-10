/**
 * mcpPersist —— 把阳光 bot 的 mac-router MCP 配置持久化进 ~/.claude.json。
 *
 * 背景：`claude mcp add --scope local` 写入的 `/home/node/.claude.json` 的
 * `projects[<cwd>].mcpServers` 配置，在 bridge 容器重建时会被 claude 首次启动的
 * 迁移逻辑重置（旧配置被备份到 backups/，新的 .claude.json projects 为空），导致
 * mac-router 丢失（阳光 bot 查不到 MySQL 等工具）。而 `.mcp.json` 文件走交互批准
 * （headless claude -p 无法批准），不可用。
 *
 * 方案：bridge 启动时，对指定 bot 工作目录幂等写入 mac-router 到 ~/.claude.json
 * 的 `projects[<cwd>].mcpServers`（与 `claude mcp add` 写入点完全一致，免审批）。
 * 重建后自动恢复，无需人工。
 *
 * 目前仅阳光 bot（/app/workspaces/yangguang）需要，配置来源 env：
 *   BRIDGE_MCP_WORKDIR=  （默认缺省则不生效，避免污染其他 bot）
 *   BRIDGE_MCP_HTTP_URL=
 *   BRIDGE_MCP_HTTP_TOKEN=
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const MCP_SERVER_NAME = 'mac-router';

interface McpEnv {
  BRIDGE_MCP_WORKDIR?: string;
  BRIDGE_MCP_HTTP_URL?: string;
  BRIDGE_MCP_HTTP_TOKEN?: string;
}

function claudeJsonPath(): string {
  return join(process.env.CLAUDE_JSON_HOME || homedir(), '.claude.json');
}

/**
 * 确保指定 bot 工作目录的 ~/.claude.json 里有 mac-router。
 * env 缺省（未配 workdir 或 url）→ 空操作返回 false。
 * 已有 → 不动；没有但 env 配了 → 写入。幂等，可重复调用。
 */
export function ensureBotMcp(env: McpEnv = process.env): boolean {
  const workdir = (env.BRIDGE_MCP_WORKDIR || '').trim();
  const url = (env.BRIDGE_MCP_HTTP_URL || '').trim();
  if (!workdir || !url) return false;

  const path = claudeJsonPath();
  let cfg: { projects?: Record<string, unknown> };
  try {
    cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { projects: {} };
  } catch {
    cfg = { projects: {} };
  }
  cfg.projects = cfg.projects || {};

  const server: Record<string, unknown> = { type: 'http', url };
  const token = (env.BRIDGE_MCP_HTTP_TOKEN || '').trim();
  if (token) server.headers = { Authorization: `Bearer ${token}` };

  const proj = (cfg.projects[workdir] as Record<string, unknown>) || (cfg.projects[workdir] = {});
  const mcpServers = (proj.mcpServers as Record<string, unknown>) || (proj.mcpServers = {});
  if (mcpServers[MCP_SERVER_NAME]) return true; // 已存在，不动

  mcpServers[MCP_SERVER_NAME] = server;
  mkdirSync(join(process.env.CLAUDE_JSON_HOME || homedir()), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`[mcpPersist] mac-router injected into ${workdir}`);
  return true;
}