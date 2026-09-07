import type { AgentUpstreamEntry, ProxyConfig, RawYamlConfig, UserUpstreamEntry } from "../types.js";
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

export interface EarlyAuthResult {
  upstreamRoute: UpstreamRoute;
  pathSpaceId: string;
  memoryKey: string;
  spaceId: string;
  verify: VerifyUserResult;
  /** 两个 handler 的 early-auth 块完全同构，仅错误响应格式不同——由调用方传入。 */
  errors: {
    unauthorized(reason: string): Response;
    forbidden(): Response;
  };
}

/**
 * 各 handler 的前置认证公共流程：路由解析 → 记忆身份解析 → user key 校验。
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
  const spaceId = upstreamRoute.spaceId;
  const memoryKey = c.req.header("x-tdai-user-key") || apiKey;
  const verify = await verifyUserKey(memoryKey, spaceId);
  if (verify.rejected) {
    return errors.unauthorized(`Authentication failed: ${verify.rejectReason ?? "unknown"}`);
  }
  // 按用户 BYOK 绑定优先于路径 agents 表：命中即覆盖上游并透传客户端模型 Key。
  const perUser = config.upstream.userUpstreams?.find((u) => u.userId === verify.userId);
  if (perUser) {
    upstreamRoute.entry = { url: perUser.url };
    upstreamRoute.apiKey = "";
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
