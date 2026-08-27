import { log } from "../report/log.js";
import type { AgentUpstreamEntry, ProxyConfig, RawYamlConfig } from "../types.js";
import type { PresetIdentity } from "../session/preset.js";

const RESERVED_PATHS = new Set(["v1", "proxy", "skill-bridge", "memory-bridge"]);
const BUILTIN_AGENTS = new Set([
  "claude-code", "codebuddy", "codex", "cursor", "hermes", "openclaw", "workbuddy", "dsh",
]);

export interface UpstreamRoute {
  agentName?: string;
  agentSource: string;
  spaceId: string;
  /** 命中 agent 时返回的 upstream 配置（url/model/binding）。 */
  entry?: AgentUpstreamEntry;
  url: string;
  /**
   * 上游认证 Key。语义简化（v4.3+）：仅对非 agent 的默认路由使用全局
   * upstream.apiKey；命中 agent 配置时始终为 ""（透传客户端的原始 Key）。
   * 不再存在 "agent 级 apiKey 覆盖" 的概念。
   */
  apiKey: string;
  model?: string;
}

/** 上游路由的统一解析入口，避免各 handler 重复拆解 URL。 */
export function resolveUpstreamRoute(config: ProxyConfig, path: string): UpstreamRoute {
  const parts = (path.split("?", 1)[0] ?? "").split("/").filter(Boolean);
  const first = parts[0];
  const agentName = first && !RESERVED_PATHS.has(first) ? first : undefined;
  const entry = agentName ? config.upstream.agents[agentName] : undefined;
  const hasSpace = first === "proxy" || !!agentName && (BUILTIN_AGENTS.has(agentName) || !!entry);
  const configuredModel = entry?.model || config.upstream.model;

  return {
    agentName,
    agentSource: agentName ?? "claude-code",
    spaceId: hasSpace ? parts[1] ?? "" : "",
    entry,
    url: entry?.url ?? config.upstream.url,
    // v4.3+ 简化：命中 agent 配置时一律透传客户端 Key（不配置/替换任何 agent 级 Key），
    // 未命中时沿用全局 upstream.apiKey 兜底。
    apiKey: entry ? "" : config.upstream.apiKey,
    model: configuredModel?.replace(/\[[^\]]*\]$/, "").trim() || undefined,
  };
}

/** 将 YAML 中的开发者上游收敛为运行时使用的明确数据契约。 */
export function parseUpstreamAgents(
  raw: NonNullable<RawYamlConfig["upstream"]>["agents"],
): Record<string, AgentUpstreamEntry> {
  const agents: Record<string, AgentUpstreamEntry> = {};
  for (const [name, entry] of Object.entries(raw ?? {})) {
    if (!entry?.url?.trim()) continue;
    const teamId = entry.binding?.team_id?.trim();
    const agentId = entry.binding?.agent_id?.trim();
    const taskId = entry.binding?.task_id?.trim();
    const memKey = entry.memory?.key?.trim();
    const memSpace = entry.memory?.spaceId?.trim();
    agents[name] = {
      url: entry.url.trim(),
      ...(entry.model?.trim() ? { model: entry.model.trim() } : {}),
      ...(teamId && agentId ? { binding: { team_id: teamId, agent_id: agentId, ...(taskId ? { task_id: taskId } : {}) } } : {}),
      ...(memKey ? { memory: { key: memKey, ...(memSpace ? { spaceId: memSpace } : {}) } } : {}),
    };
  }
  return agents;
}

export interface MemoryIdentity {
  memoryKey: string;
  spaceId: string;
  /** 是否为带 memory 配置的绑定 agent（agent 账号身份）。 */
  isAgent: boolean;
}

/**
 * 解析本请求的记忆身份。命中带 memory 配置的绑定 agent 时，用服务端固定的
 * agent 记忆账号（key + spaceId）覆盖调用方身份；否则回退调用方显式传入的
 * x-tdai-user-key，再回退模型 Key。纯函数，无 IO。
 */
export function resolveMemoryIdentity(
  route: UpstreamRoute,
  headerMemoryKey: string | null | undefined,
  apiKey: string,
  pathSpaceId: string,
): MemoryIdentity {
  const mem = route.entry?.memory;
  if (mem?.key) {
    return { memoryKey: mem.key, spaceId: mem.spaceId || pathSpaceId, isAgent: true };
  }
  return { memoryKey: headerMemoryKey || apiKey, spaceId: pathSpaceId, isAgent: false };
}

/** 绑定开发者上游只允许绑定 Team 的 active member 调用。 */
export async function isAgentBindingAuthorized(
  route: UpstreamRoute,
  userKey: string,
  userId: string,
  config: ProxyConfig,
): Promise<boolean> {
  // 带 memory 配置的 agent：早期 verify 已用 agent 记忆账号 + space 通过，
  // agent 账号有效即授权，不再要求开发者是绑定 Team 的 active member。
  if (route.entry?.memory?.key) return true;
  const teamId = route.entry?.binding?.team_id;
  if (!teamId) return true;
  if (!config.auth.enabled || !config.auth.url || !route.spaceId || !userKey || !userId) return false;

  try {
    const resp = await fetch(config.auth.url.replace(/\/+$/, "") + "/v3/meta/team-member/get", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": route.spaceId,
        "x-tdai-user-key": userKey,
      },
      body: JSON.stringify({ team_id: teamId, user_id: userId }),
      signal: config.auth.timeoutMs > 0 ? AbortSignal.timeout(config.auth.timeoutMs) : undefined,
    });
    if (!resp.ok) return false;
    const body = await resp.json() as {
      code?: number;
      data?: { team_id?: string; user_id?: string; status?: string };
    };
    return body.code === 0
      && body.data?.team_id === teamId
      && body.data.user_id === userId
      && body.data.status === "active";
  } catch (err: unknown) {
    log.warn("auth.agentBinding.error", {
      serviceId: route.spaceId,
      userId,
      teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function trustedPreset(route: UpstreamRoute): PresetIdentity | undefined {
  const binding = route.entry?.binding;
  return binding ? {
    teamId: binding.team_id,
    agentId: binding.agent_id,
    ...(binding.task_id ? { taskId: binding.task_id } : {}),
  } : undefined;
}
