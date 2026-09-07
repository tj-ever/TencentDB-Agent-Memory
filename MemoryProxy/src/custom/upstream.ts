import type { AgentIdUpstreamEntry, AgentUpstreamEntry, ProxyConfig, RawYamlConfig, UserUpstreamEntry } from "../types.js";
import { verifyUserKey } from "../auth.js";
import type { VerifyUserResult } from "../auth.js";

const RESERVED_PATHS = new Set(["v1", "proxy", "skill-bridge", "memory-bridge"]);
const BUILTIN_AGENTS = new Set([
  "claude-code", "codebuddy", "codex", "cursor", "hermes", "openclaw", "workbuddy", "dsh", "opencode",
]);

/** 内置 agent 名单的唯一权威（credit-reporter 等也引用，勿在别处再拷贝正则）。 */
export function isBuiltinAgent(name: string): boolean {
  return BUILTIN_AGENTS.has(name);
}

export interface UpstreamRoute {
  agentName?: string;
  agentSource: string;
  spaceId: string;
  /** 命中 agent 时返回的 upstream 配置（开发者上游只做 URL 分流，字段仅 url）。 */
  entry?: AgentUpstreamEntry;
  url: string;
  /**
   * 上游认证 Key。命中 agent 时始终为 ""（透传客户端的原始 Key）；未命中时用
   * 全局 upstream.apiKey 兜底。不存在 "agent 级 apiKey" 的概念。
   */
  apiKey: string;
}

/** 上游路由的统一解析入口，避免各 handler 重复拆解 URL。 */
export function resolveUpstreamRoute(config: ProxyConfig, path: string): UpstreamRoute {
  const parts = (path.split("?", 1)[0] ?? "").split("/").filter(Boolean);
  const first = parts[0];
  const agentName = first && !RESERVED_PATHS.has(first) ? first : undefined;
  const entry = agentName ? config.upstream.agents[agentName] : undefined;
  const hasSpace = first === "proxy" || !!agentName && (BUILTIN_AGENTS.has(agentName) || !!entry);

  return {
    agentName,
    agentSource: agentName ?? "claude-code",
    spaceId: hasSpace ? parts[1] ?? "" : "",
    entry,
    url: entry?.url ?? config.upstream.url,
    apiKey: entry ? "" : config.upstream.apiKey,
  };
}

/** 将 YAML 中的开发者上游收敛为运行时契约：每个 agent 只有一个 url。 */
export function parseUpstreamAgents(
  raw: NonNullable<RawYamlConfig["upstream"]>["agents"],
): Record<string, AgentUpstreamEntry> {
  const agents: Record<string, AgentUpstreamEntry> = {};
  for (const [name, entry] of Object.entries(raw ?? {})) {
    if (!entry?.url?.trim()) continue;
    agents[name] = { url: entry.url.trim() };
  }
  return agents;
}

/** 将 YAML 中的按用户绑定收敛为运行时契约：userId 去重、空值丢弃。 */
export function parseUserUpstreams(
  raw: NonNullable<RawYamlConfig["upstream"]>["userUpstreams"],
): UserUpstreamEntry[] {
  const out: UserUpstreamEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    const userId = entry?.userId?.trim();
    const url = entry?.url?.trim();
    if (!userId || !url || seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, url });
  }
  return out;
}

/** 将 YAML 中的按 agent 绑定收敛为运行时契约：agentId 去重、空值丢弃。 */
export function parseAgentUpstreams(
  raw: NonNullable<RawYamlConfig["upstream"]>["agentUpstreams"],
): AgentIdUpstreamEntry[] {
  const out: AgentIdUpstreamEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    const agentId = entry?.agentId?.trim();
    const url = entry?.url?.trim();
    if (!agentId || !url || seen.has(agentId)) continue;
    seen.add(agentId);
    out.push({ agentId, url, spaceId: entry?.spaceId?.trim() || undefined });
  }
  return out;
}

export interface EarlyAuthResult {
  upstreamRoute: UpstreamRoute;
  pathSpaceId: string;
  memoryKey: string;
  spaceId: string;
  verify: VerifyUserResult;
  /**
   * agent 直连端点（/claude-code/<agent-id>）命中绑定后反解出的身份预设。
   * 由 handler 在构建 lcHeaders 后合并进 x-team-id/x-agent-id/x-task-id，
   * 让官方 headerAutoSelect → direct-register 流程原生只注入 [Agent]（无真实
   * task 也注入，taskDetail=null）。未命中 agent 直连时 undefined。
   */
  agentPreset?: { teamId: string; agentId: string; taskId?: string };
  /** 两个 handler 的 early-auth 块完全同构，仅错误响应格式不同——由调用方传入。 */
  errors: {
    unauthorized(reason: string): Response;
    forbidden(): Response;
  };
}

/**
 * agent 直连端点：把 `/claude-code/<agent-id>` 反解成 (teamId, agentId, taskId=defaultTaskId)。
 *
 * 命中条件：路径第一段 agentSource 是 `claude-code`，第二段在 `agentUpstreams` 绑定表里
 * （未绑定 → 回落原 space 语义，零行为变化）。反解只做一步——在该 agent 的租户实例
 * （绑定的 spaceId，默认 config.tdai.serviceId）上用开发者的记忆身份 user_id 调
 * MetadataClient.listTeams(userId) → per-team listAgents（team-wide）→ 定位 agent 属
 * team。不做跨实例探测（YAGNI）——agent 不归该开发者可见则反解失败，返回 undefined
 * 回落表单。任何异常静默吞掉（不阻塞主流程）。
 */
async function tryResolveAgentPreset(
  agentEntry: AgentIdUpstreamEntry,
  userId: string,
  agentId: string,
  config: ProxyConfig,
  userKey: string,
): Promise<{ teamId: string; agentId: string; taskId?: string } | undefined> {
  const spaceId = agentEntry.spaceId?.trim() || config.tdai?.serviceId || "default";
  try {
    const { MetadataClient } = await import("../meta/client.js");
    const client = new MetadataClient(config.coreSkill, spaceId, userKey);
    const teams = await client.listTeams(userId);
    for (const team of teams) {
      const agents = await client.listAgents(team.team_id);
      if (agents.some((a) => a.agent_id === agentId)) {
        const taskId = config.sessionInit?.defaultTaskId || "default";
        return { teamId: team.team_id, agentId, taskId };
      }
    }
    return undefined;
  } catch (err) {
    console.log(`[agent-direct] resolve agent=${agentId} team in space=${spaceId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * 各 handler 的前置认证公共流程：路由解析 → agent 直连判定 → 记忆身份解析 → user key 校验。
 * 记忆身份：x-tdai-user-key 优先，回退模型 Key（内置端点上两者本就是同一把
 * sk-mem-*）。开发者上游必须在请求头显式携带 x-tdai-user-key。
 */
export async function earlyAuth(
  c: { req: { path: string; header(name: string): string | undefined } },
  config: ProxyConfig,
  apiKey: string,
  errors: EarlyAuthResult["errors"],
): Promise<EarlyAuthResult | Response> {
  const upstreamRoute = resolveUpstreamRoute(config, c.req.path);

  // ── agent 直连判定：/claude-code/<agent-id> 命中 agentUpstreams 绑定 ──
  // 无真实 space 段（第二段时间上是 agent_id）；命中绑定 → 用绑定租户验证 + 反解
  // team + 覆盖路由；未命中 → 回落原 space 语义（零行为变化）。
  const isClaudeCode = upstreamRoute.agentSource === "claude-code";
  const pathSecond = upstreamRoute.spaceId.trim();
  const agentEntry = isClaudeCode
    ? config.upstream.agentUpstreams?.find((a) => a.agentId === pathSecond)
    : undefined;
  if (agentEntry) {
    const memoryKey = c.req.header("x-tdai-user-key") || apiKey;
    // 用绑定租户验证记忆 key（而不是空 spaceId——auth 对空 space 直接 reject）。
    const spaceId = agentEntry.spaceId?.trim() || config.tdai?.serviceId || "default";
    const verify = await verifyUserKey(memoryKey, spaceId);
    if (verify.rejected) {
      return errors.unauthorized(`Authentication failed: ${verify.rejectReason ?? "unknown"}`);
    }
    upstreamRoute.spaceId = spaceId;
    upstreamRoute.entry = { url: agentEntry.url };
    upstreamRoute.apiKey = c.req.header("x-tdai-user-key") ? "" : config.upstream.apiKey;
    // 反解 agent→team（request-scoped MetadataClient on bound space）。
    const userKey = memoryKey || config.tdai?.apiKey || "";
    const agentPreset = await tryResolveAgentPreset(agentEntry, verify.userId, pathSecond, config, userKey);
    if (!agentPreset) {
      // 反解失败：agent 不归该开发者可见，或内核不可用 → 回落表单（不 401，
      // 让用户/开发者看到官方流程），但上游已按绑定换好。
      console.log(`[agent-direct] session /claude-code/${pathSecond} resolve team failed → fallback to form`);
    }
    return {
      upstreamRoute,
      pathSpaceId: pathSecond,
      memoryKey,
      spaceId,
      verify,
      agentPreset,
      errors,
    };
  }

  // ── 常规路径：space 语义 + 按用户 BYOK 绑定 ──
  const spaceId = upstreamRoute.spaceId;
  const memoryKey = c.req.header("x-tdai-user-key") || apiKey;
  const verify = await verifyUserKey(memoryKey, spaceId);
  if (verify.rejected) {
    return errors.unauthorized(`Authentication failed: ${verify.rejectReason ?? "unknown"}`);
  }
  // 按用户 BYOK 绑定优先于路径 agents 表：命中即覆盖上游 URL。
  // 模型 Key 按「是否显式携带记忆身份」分流（区分开发者与 bridge bot）：
  //  - 带 x-tdai-user-key（开发者自带模型 key 直连官方端点）→ 透传客户端 Key
  //    （BYOK：url 用 binding 里的、模型 token 用开发者自己的，两者都不是平台的）；
  //  - 不带（bridge bot harness 拿 sk-mem 记忆 Key 当 AUTH_TOKEN）→ 用全局 key，
  //    否则透传会把 sk-mem 泄给第三方 upstream。开发者为了通过记忆鉴权必然带这个头。
  const perUser = config.upstream.userUpstreams?.find((u) => u.userId === verify.userId);
  if (perUser) {
    upstreamRoute.entry = { url: perUser.url };
    upstreamRoute.apiKey = c.req.header("x-tdai-user-key") ? "" : config.upstream.apiKey;
  }
  return {
    upstreamRoute,
    pathSpaceId: spaceId,
    memoryKey,
    spaceId,
    verify,
    errors,
  };
}
