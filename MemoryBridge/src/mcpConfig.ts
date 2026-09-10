/**
 * mcpConfig —— 机器人工作用户级 MCP 注入。
 *
 * claude 的 project-scope MCP 按启动目录（cwd）精确匹配：在 `/app` 下 `claude mcp add` 的
 * server，换到 `/app/workspaces/<bot>` 启动就完全看不到（实测 `claude mcp list` =
 * "No MCP servers configured"）。机器人 bridge 以每个 bot 的 work_dir 为 cwd spawn claude，
 * 所以必须在 work_dir 放一份目录级 `.mcp.json`，claude 才会加载其中的 MCP server。
 *
 * 目前注入的是 Mac mini 上的 MCP Router 聚合器（mac-router）——提供 MySQL 查询工具
 * （get_schema_info / get_table_sample / execute_sql，打 sungrow_market 等）与联网搜索、
 * 文档查询、browser 等工具。bot 通过 HTTP 跨局域网调用，MCP server 与 bot 不在一台机器
 * 也能工作（streamable HTTP，claude 只是发起 http 请求）。
 *
 * 地址/token 来自进程 env（容器 docker-compose 注入），未配置时静默跳过：
 *   BRIDGE_MCP_HTTP_URL    如 http://192.168.0.103:3282/mcp
 *   BRIDGE_MCP_HTTP_TOKEN  如 mcpr_xxx
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MCP_URL = process.env.BRIDGE_MCP_HTTP_URL || '';
const MCP_TOKEN = process.env.BRIDGE_MCP_HTTP_TOKEN || '';

/** 向 MCP 配置导出的内聚接口：便于单测替换 env。 */
export interface McpConfigEnv {
  BRIDGE_MCP_HTTP_URL?: string;
  BRIDGE_MCP_HTTP_TOKEN?: string;
}

export function resolveMcpServer(env: McpConfigEnv = process.env) {
  const url = (env.BRIDGE_MCP_HTTP_URL || '').trim();
  if (!url) return null;
  const headers: Record<string, string> = {};
  const token = (env.BRIDGE_MCP_HTTP_TOKEN || '').trim();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return {
    type: 'http',
    url,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/**
 * 确保 bot 工作目录存在 `.mcp.json`（指向 Mac 的 mac-router）。
 * env 未配置 → 返回 false 且不创建任何文件；已配置 → 写入（若文件已存在且内容相同则跳过写盘）。
 */
export function ensureMcpJson(workDir: string, env: McpConfigEnv = process.env): boolean {
  const server = resolveMcpServer(env);
  if (!server) return false;
  mkdirSync(workDir, { recursive: true });
  const target = join(workDir, '.mcp.json');
  const content = JSON.stringify({ mcpServers: { 'mac-router': server } }, null, 2) + '\n';
  if (existsSync(target)) {
    // 幂等：内容一致就不再写盘（避免每轮 startBot 都触碰 mtime）。
    try {
      if (readFileSync(target, 'utf-8') === content) return true;
    } catch {
      /* 读失败（并发删/权限）就重写 */
    }
  }
  writeFileSync(target, content, 'utf8');
  return true;
}