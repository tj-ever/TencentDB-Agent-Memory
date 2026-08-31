import type { Context } from "hono";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { isAuthEnabled, verifyUserKey } from "../../auth.js";
import type { AgentUpstreamEntry, ProxyConfig, UpstreamProfile } from "../../types.js";

const mask = (value: string): string => value ? `${value.slice(0, 6)}…` : "";

interface AgentChange {
  name: string;
  originalName?: string;
  url: string;
  userAgent?: string;
  model?: string;
  binding?: { team_id?: string; agent_id?: string; task_id?: string };
  memory?: { key?: string; spaceId?: string };
}

interface ProfileChange {
  id?: string;
  name?: string;
  url?: string;
  /** 掩码（含 "…"）= 未修改，保留磁盘明文；空 = 清空。 */
  apiKey?: string;
  userAgent?: string;
  model?: string;
  supportsImages?: boolean;
  enabled?: boolean;
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
    userAgent: config.upstream.userAgent ?? "",
    model: config.upstream.model ?? "",
    supportsImages: config.upstream.supportsImages === true,
    profiles: config.upstreamProfiles.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      apiKey: mask(p.apiKey),
      userAgent: p.userAgent ?? "",
      model: p.model ?? "",
      supportsImages: p.supportsImages === true,
      enabled: p.enabled,
    })),
    agents: Object.entries(config.upstream.agents).map(([name, entry]) => ({
      name,
      url: entry.url,
      userAgent: entry.userAgent ?? "",
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
function persist(
  config: ProxyConfig,
  upstream: ProxyConfig["upstream"],
  profiles: UpstreamProfile[] | null,
): void {
  const target = config.overridePath || config.configPath;
  let root: Record<string, unknown> = {};
  try {
    const parsed = yamlLoad(readFileSync(target, "utf8"));
    if (parsed && typeof parsed === "object") root = parsed as Record<string, unknown>;
  } catch { /* override 文件首次写入 */ }
  root.upstream = { ...upstream, supportsImages: upstream.supportsImages === true };
  // profiles 为 null 表示本次 PUT 不涉及（旧版单上游路径），保留磁盘现值。
  if (profiles) {
    root.upstreamProfiles = profiles.map(({ enabled, ...rest }) => ({ ...rest, enabled: enabled === true }));
  }
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, yamlDump(root));
  renameSync(temp, target);
}

/**
 * 入站 profiles → 存储 + 生效。规则：
 *   - 掩码 key（含 "…"）保留磁盘明文（面板回显掩码，未改不动）
 *   - 恰好一条 enabled（面板单选）；0 条或多条都拒绝，防止静默清空生效上游
 * 返回 { profiles, upstreamPatch }：upstreamPatch 由 enabled 那条派生
 * （仅 url/apiKey/userAgent/model/supportsImages，agents 由调用方保留）。
 */
export function applyProfileChanges(
  changes: ProfileChange[],
  current: UpstreamProfile[],
): { profiles: UpstreamProfile[]; upstreamPatch: Pick<ProxyConfig["upstream"], "url" | "apiKey"> & Partial<ProxyConfig["upstream"]> } {
  const profiles: UpstreamProfile[] = changes.map((c, i) => {
    const url = c.url?.trim() ?? "";
    if (!url) throw new Error("invalid profile url");
    // 掩码 key = 未修改：按 id 命中保留磁盘明文；新行传了掩码则视为空。
    const prev = current.find((p) => p.id === (c.id?.trim() || `up-${i + 1}`));
    const key = c.apiKey && !c.apiKey.includes("…") ? c.apiKey : (prev?.apiKey ?? "");
    return {
      id: c.id?.trim() || `up-${i + 1}`,
      name: c.name?.trim() || url,
      url,
      apiKey: key,
      ...(c.userAgent?.trim() ? { userAgent: c.userAgent.trim() } : {}),
      ...(c.model?.trim() ? { model: c.model.trim() } : {}),
      ...(c.supportsImages === true ? { supportsImages: true } : {}),
      enabled: c.enabled === true,
    };
  });
  const enabledOnes = profiles.filter((p) => p.enabled);
  if (enabledOnes.length !== 1) {
    throw new Error(`exactly one profile must be enabled (got ${enabledOnes.length})`);
  }
  const active = enabledOnes[0]!;
  const upstreamPatch = {
    url: active.url,
    apiKey: active.apiKey,
    ...(active.userAgent ? { userAgent: active.userAgent } : {}),
    ...(active.model ? { model: active.model } : {}),
    ...(active.supportsImages ? { supportsImages: true } : {}),
  };
  return { profiles, upstreamPatch };
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
      ...(change.userAgent?.trim() ? { userAgent: change.userAgent.trim() } : {}),
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
        userAgent?: unknown;
        model?: unknown;
        supportsImages?: unknown;
        profiles?: ProfileChange[];
        agents?: AgentChange[];
      }>().catch(() => null);
      if (!body || (typeof body.url !== "string" || !body.url.trim()) && !Array.isArray(body.profiles)) {
        return c.json({ error: "invalid url" }, 400);
      }

      try {
        // profiles 路径：面板表格全量提交，enabled 那条派生为生效 upstream。
        let profiles: UpstreamProfile[] | null = null;
        if (Array.isArray(body.profiles)) {
          const applied = applyProfileChanges(body.profiles, config.upstreamProfiles);
          profiles = applied.profiles;
          const nextUpstream: ProxyConfig["upstream"] = {
            ...config.upstream,
            ...applied.upstreamPatch,
          };
          if (Array.isArray(body.agents)) nextUpstream.agents = agentMap(body.agents, config.upstream.agents);
          persist(config, nextUpstream, profiles);
          config.upstream = nextUpstream;
          config.upstreamProfiles = profiles;
          return c.json(snapshot(config));
        }

        const next: ProxyConfig["upstream"] = {
          ...config.upstream,
          url: (body.url as string).trim(),
          ...(typeof body.userAgent === "string" ? { userAgent: body.userAgent.trim() || undefined } : {}),
          ...(typeof body.model === "string" ? { model: body.model.trim() || undefined } : {}),
          ...(typeof body.supportsImages === "boolean" ? { supportsImages: body.supportsImages } : {}),
        };
        if (typeof body.apiKey === "string" && body.apiKey.trim() && !body.apiKey.includes("…")) {
          next.apiKey = body.apiKey.trim();
        }
        if (Array.isArray(body.agents)) next.agents = agentMap(body.agents, config.upstream.agents);
        persist(config, next, null);
        config.upstream = next;
        return c.json(snapshot(config));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const badRequest = detail === "invalid or duplicate agent name"
          || detail === "invalid profile url"
          || detail.startsWith("exactly one profile");
        const status = badRequest ? 400 : 500;
        return c.json({ error: status === 400 ? detail : "persist failed", detail }, status);
      }
    },
  };
}
