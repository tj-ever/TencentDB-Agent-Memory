import type { Context } from "hono";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { isAuthEnabled, verifyUserKey } from "../../auth.js";
import type { AgentUpstreamEntry, ProxyConfig } from "../../types.js";

const mask = (value: string): string => value ? `${value.slice(0, 6)}…` : "";

interface AgentChange {
  name: string;
  originalName?: string;
  url: string;
  model?: string;
  binding?: { team_id?: string; agent_id?: string; task_id?: string };
  memory?: { key?: string; spaceId?: string };
}

async function authorized(c: Context, config: ProxyConfig, requireAdmin: boolean): Promise<boolean> {
  const serviceId = c.req.header("x-tdai-service-id")?.trim();
  const userKey = c.req.header("x-tdai-user-key")?.trim();
  if (!serviceId || !userKey || config.tdai.serviceId && serviceId !== config.tdai.serviceId) return false;
  const verified = await verifyUserKey(userKey, config.tdai.serviceId || serviceId);
  return !verified.rejected && (!requireAdmin || isAuthEnabled() && verified.userType === "system_admin");
}

function snapshot(config: ProxyConfig) {
  return {
    url: config.upstream.url,
    apiKey: mask(config.upstream.apiKey),
    model: config.upstream.model ?? "",
    supportsImages: config.upstream.supportsImages === true,
    agents: Object.entries(config.upstream.agents).map(([name, entry]) => ({
      name,
      url: entry.url,
      model: entry.model ?? "",
      binding: entry.binding,
      // memory.key 出站回显仅给掩码，避免泄露明文凭据；spaceId 可明文。
      ...(entry.memory
        ? { memory: { key: mask(entry.memory.key ?? ""), ...(entry.memory.spaceId ? { spaceId: entry.memory.spaceId } : {}) } }
        : {}),
    })),
  };
}

/** 先原子持久化，再切换运行时对象，避免内存与磁盘状态分叉。 */
function persist(config: ProxyConfig, upstream: ProxyConfig["upstream"]): void {
  const target = config.overridePath || config.configPath;
  let root: Record<string, unknown> = {};
  try {
    const parsed = yamlLoad(readFileSync(target, "utf8"));
    if (parsed && typeof parsed === "object") root = parsed as Record<string, unknown>;
  } catch { /* override 文件首次写入 */ }
  root.upstream = { ...upstream, supportsImages: upstream.supportsImages === true };
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, yamlDump(root));
  renameSync(temp, target);
}

export function agentMap(changes: AgentChange[], current: Record<string, AgentUpstreamEntry>): Record<string, AgentUpstreamEntry> {
  const result: Record<string, AgentUpstreamEntry> = {};
  for (const change of changes) {
    const name = change.name?.trim();
    const url = change.url?.trim();
    if (!name || !url || !/^[A-Za-z0-9._-]+$/.test(name) || result[name]) {
      throw new Error("invalid or duplicate agent name");
    }
    const teamId = change.binding?.team_id?.trim();
    const agentId = change.binding?.agent_id?.trim();
    const taskId = change.binding?.task_id?.trim();
    const memKey = change.memory?.key?.trim();
    const memSpace = change.memory?.spaceId?.trim();
    // agent 改名时按旧名查存量条目（掩码 key / spaceId 的保留源），否则改名即静默丢 key → 重复开号。
    const prev = current[change.originalName?.trim() || name];
    // 入站 memory.key 为掩码（"…"）视为未修改：保留磁盘现有明文，避免把掩码写坏配置。
    const retainedKey = memKey?.includes("…") ? prev?.memory?.key : undefined;
    const effectiveKey = retainedKey || (memKey && !memKey.includes("…") ? memKey : undefined);
    const effectiveSpace = memSpace || prev?.memory?.spaceId;
    result[name] = {
      url,
      ...(change.model?.trim() ? { model: change.model.trim() } : {}),
      ...(teamId && agentId ? { binding: { team_id: teamId, agent_id: agentId, ...(taskId ? { task_id: taskId } : {}) } } : {}),
      ...(effectiveKey
        ? { memory: { key: effectiveKey, ...(effectiveSpace ? { spaceId: effectiveSpace } : {}) } }
        : {}),
    };
  }
  return result;
}

export function createUpstreamConfigHandlers(config: ProxyConfig) {
  return {
    get: async (c: Context): Promise<Response> => {
      if (!(await authorized(c, config, false))) return c.json({ error: "unauthorized" }, 401);
      return c.json(snapshot(config));
    },
    put: async (c: Context): Promise<Response> => {
      if (!(await authorized(c, config, true))) return c.json({ error: "admin required" }, 403);
      // 未配置 override 文件时拒绝持久化：persist 的 yamlDump 会重写主 config.yaml，抹掉全部注释。
      if (!config.overridePath) {
        return c.json({ error: "PROXY_OVERRIDE_CONFIG not set; refusing to rewrite main config (comments would be lost)" }, 400);
      }
      const body = await c.req.json<{
        url?: unknown;
        apiKey?: unknown;
        model?: unknown;
        supportsImages?: unknown;
        agents?: AgentChange[];
      }>().catch(() => null);
      if (!body || typeof body.url !== "string" || !body.url.trim()) {
        return c.json({ error: "invalid url" }, 400);
      }

      try {
        const next: ProxyConfig["upstream"] = {
          ...config.upstream,
          url: body.url.trim(),
          ...(typeof body.model === "string" ? { model: body.model.trim() || undefined } : {}),
          ...(typeof body.supportsImages === "boolean" ? { supportsImages: body.supportsImages } : {}),
        };
        if (typeof body.apiKey === "string" && body.apiKey.trim() && !body.apiKey.includes("…")) {
          next.apiKey = body.apiKey.trim();
        }
        if (Array.isArray(body.agents)) next.agents = agentMap(body.agents, config.upstream.agents);
        persist(config, next);
        config.upstream = next;
        return c.json(snapshot(config));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const status = detail === "invalid or duplicate agent name" ? 400 : 500;
        return c.json({ error: status === 400 ? detail : "persist failed", detail }, status);
      }
    },
  };
}
