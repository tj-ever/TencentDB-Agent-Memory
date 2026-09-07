import { describe, expect, it, vi } from "vitest";
import { parseUpstreamAgents, parseUserUpstreams, resolveUpstreamRoute, type EarlyAuthResult, type UpstreamRoute } from "../upstream.js";
import type { AgentUpstreamEntry, ProxyConfig } from "../../types.js";
import type { VerifyUserResult } from "../../auth.js";

// earlyAuth 内部调用内核 verify（网络）——按 userId mock 掉。
vi.mock("../../auth.js", () => ({
  verifyUserKey: vi.fn(async (_key: string, spaceId: string): Promise<VerifyUserResult> => ({
    rejected: false,
    userId: spaceId === "hit" ? "usr-a" : "usr-other",
    userType: "user",
  })),
}));

const { earlyAuth } = await import("../upstream.js");

function route(entry: AgentUpstreamEntry | undefined, spaceInPath = "spc-path"): UpstreamRoute {
  const cfg = { upstream: { url: "https://default.example.com/v1", apiKey: "sk-global", agents: entry ? { fw1: entry } : {} } } as unknown as ProxyConfig;
  return resolveUpstreamRoute(cfg, `/fw1/${spaceInPath}`);
}

interface RawEntry {
  url?: string;
  // 历史配置可能残留已废弃字段（binding/memory/model/userAgent），解析时应静默忽略。
  [k: string]: unknown;
}

function parseEntry(entry: RawEntry): AgentUpstreamEntry | undefined {
  const raw = { url: "http://x/x", ...entry } as NonNullable<Parameters<typeof parseUpstreamAgents>[0]>["fw1"];
  return parseUpstreamAgents({ fw1: raw }).fw1;
}

describe("resolveUpstreamRoute", () => {
  it("命中 agent：url 取 agent 配置，apiKey 清空（透传客户端 Key）", () => {
    const r = route({ url: "https://dev.example.com/v1" });
    expect(r.url).toBe("https://dev.example.com/v1");
    expect(r.apiKey).toBe("");
    expect(r.entry).toEqual({ url: "https://dev.example.com/v1" });
    expect(r.agentSource).toBe("fw1");
    expect(r.spaceId).toBe("spc-path");
  });

  it("未命中 agent：url/apiKey 均用全局兜底", () => {
    const cfg = { upstream: { url: "https://default.example.com/v1", apiKey: "sk-global", agents: {} } } as unknown as ProxyConfig;
    const r = resolveUpstreamRoute(cfg, "/v1/messages");
    expect(r.url).toBe("https://default.example.com/v1");
    expect(r.apiKey).toBe("sk-global");
    expect(r.entry).toBeUndefined();
  });
});

describe("parseUpstreamAgents", () => {
  it("只保留 url，历史遗留字段静默忽略", () => {
    const entry = parseEntry({
      url: "https://dev.example.com/v1",
      model: "m",
      userAgent: "claude-cli/1.0",
      binding: { team_id: "t", agent_id: "a" },
      memory: { key: "sk-mem-agent", spaceId: "spc-agent" },
      apiKey: "sk-legacy",
    });
    expect(entry).toEqual({ url: "https://dev.example.com/v1" });
  });

  it("url 空白的条目丢弃", () => {
    expect(parseEntry({ url: "  " })).toBeUndefined();
  });
});

describe("parseUserUpstreams", () => {
  it("空值丢弃、userId 去重", () => {
    const out = parseUserUpstreams([
      { userId: "usr-a", url: "https://a.example.com/v1" },
      { userId: "  ", url: "https://x.example.com/v1" },
      { userId: "usr-b", url: " " },
      { userId: "usr-a", url: "https://dup.example.com/v1" },
    ] as NonNullable<Parameters<typeof parseUserUpstreams>[0]>);
    expect(out).toEqual([{ userId: "usr-a", url: "https://a.example.com/v1" }]);
  });
});

describe("earlyAuth 按用户绑定", () => {
  const errors = {
    unauthorized: (reason: string) => new Response(reason, { status: 401 }),
    forbidden: () => new Response(null, { status: 403 }),
  };
  const req = (path: string, withIdentity = false) =>
    ({
      req: {
        path,
        header: (n: string) => (withIdentity && n === "x-tdai-user-key") ? "sk-mem-usr-a" : undefined,
      },
    });
  const cfgWith = (userUpstreams: Array<{ userId: string; url: string }>) =>
    ({
      upstream: {
        url: "https://default.example.com/v1",
        apiKey: "sk-global",
        agents: {},
        userUpstreams,
      },
    }) as unknown as ProxyConfig;

  it("命中 userId + 显式记忆身份（开发者）：透传客户端模型 Key，url 用 binding（BYOK）", async () => {
    const r = await earlyAuth(req("/claude-code/hit", true), cfgWith([{ userId: "usr-a", url: "https://byok.example.com/v1" }]), "sk-model", errors) as EarlyAuthResult;
    expect(r.upstreamRoute.entry).toEqual({ url: "https://byok.example.com/v1" });
    expect(r.upstreamRoute.apiKey).toBe("");
  });

  it("命中 userId + 无显式记忆身份（bridge bot 拿记忆 Key 当 token）：用全局 key，防 sk-mem 泄给上游", async () => {
    const r = await earlyAuth(req("/claude-code/hit"), cfgWith([{ userId: "usr-a", url: "https://byok.example.com/v1" }]), "sk-mem-bot", errors) as EarlyAuthResult;
    expect(r.upstreamRoute.entry).toEqual({ url: "https://byok.example.com/v1" });
    expect(r.upstreamRoute.apiKey).toBe("sk-global");
  });

  it("未命中 userId：走全局兜底", async () => {
    const r = await earlyAuth(req("/claude-code/miss", true), cfgWith([{ userId: "usr-a", url: "https://byok.example.com/v1" }]), "sk-model", errors) as EarlyAuthResult;
    expect(r.upstreamRoute.entry).toBeUndefined();
    expect(r.upstreamRoute.url).toBe("https://default.example.com/v1");
    expect(r.upstreamRoute.apiKey).toBe("sk-global");
  });
});

describe("earlyAuth agent 直连端点（/claude-code/<agent-id>）", () => {
  const errors = {
    unauthorized: (reason: string) => new Response(reason, { status: 401 }),
    forbidden: () => new Response(null, { status: 403 }),
  };
  const cfgBase = () =>
    ({
      upstream: { url: "https://default.example.com/v1", apiKey: "sk-global", agents: {} },
      tdai: { serviceId: "s1" },
      coreSkill: { endpoint: "http://mem:8420", serviceToken: "t", serviceId: "s1", timeoutMs: 1000 },
      sessionInit: { defaultTaskId: "T" },
    }) as unknown as ProxyConfig;

  it("命中 agentId 绑定：路由覆盖为入口、模型 Key 透传、agentPreset 带默认 task", async () => {
    // 反解 agent→team：mock MetadataClient 的 listTeams/listAgents。
    const meta = await import("../../meta/client.js");
    const realTeams = meta.MetadataClient.prototype.listTeams;
    const realAgents = meta.MetadataClient.prototype.listAgents;
    meta.MetadataClient.prototype.listTeams = async () => [{ team_id: "team-a" }] as never;
    meta.MetadataClient.prototype.listAgents = async (teamId: string) =>
      teamId === "team-a" ? [{ agent_id: "agt-x", team_id: "team-a" }] as never : [];
    const cfg = {
      ...cfgBase(),
      upstream: {
        ...cfgBase().upstream,
        agentUpstreams: [{ agentId: "agt-x", url: "https://byok.example.com/v1", spaceId: "s1" }],
      },
    } as ProxyConfig;
    try {
      const r = await earlyAuth(
        { req: { path: "/claude-code/agt-x/v1/messages", header: () => "sk-mem-user-x" } } as never,
        cfg, "sk-model", errors,
      ) as EarlyAuthResult;
      expect(r.upstreamRoute.entry).toEqual({ url: "https://byok.example.com/v1" });
      expect(r.upstreamRoute.apiKey).toBe("");
      expect(r.agentPreset).toEqual({ teamId: "team-a", agentId: "agt-x", taskId: "T" });
    } finally {
      meta.MetadataClient.prototype.listTeams = realTeams;
      meta.MetadataClient.prototype.listAgents = realAgents;
    }
  });

  it("命中 agentId 绑定 + 无记忆身份头（bot 形）→ 全局 key、仍走绑定 url", async () => {
    const meta = await import("../../meta/client.js");
    const realTeams = meta.MetadataClient.prototype.listTeams;
    const realAgents = meta.MetadataClient.prototype.listAgents;
    meta.MetadataClient.prototype.listTeams = async () => [{ team_id: "team-a" }] as never;
    meta.MetadataClient.prototype.listAgents = async (teamId: string) =>
      teamId === "team-a" ? [{ agent_id: "agt-x", team_id: "team-a" }] as never : [];
    const cfg = {
      ...cfgBase(),
      upstream: {
        ...cfgBase().upstream,
        agentUpstreams: [{ agentId: "agt-x", url: "https://byok.example.com/v1", spaceId: "s1" }],
      },
    } as ProxyConfig;
    try {
      const r = await earlyAuth(
        { req: { path: "/claude-code/agt-x/v1/messages", header: () => undefined } } as never,
        cfg, "sk-mem-bot", errors,
      ) as EarlyAuthResult;
      expect(r.upstreamRoute.entry).toEqual({ url: "https://byok.example.com/v1" });
      expect(r.upstreamRoute.apiKey).toBe("sk-global");
    } finally {
      meta.MetadataClient.prototype.listTeams = realTeams;
      meta.MetadataClient.prototype.listAgents = realAgents;
    }
  });

  it("未命中 agentId 绑定 → 回落全局 space 语义（无 agentPreset）", async () => {
    const r = await earlyAuth(
      { req: { path: "/claude-code/default/v1/messages", header: () => "x-mem" } } as never,
      cfgBase(), "sk-model", errors,
    ) as EarlyAuthResult;
    expect(r.agentPreset).toBeUndefined();
    expect(r.upstreamRoute.entry).toBeUndefined();
    expect(r.upstreamRoute.url).toBe("https://default.example.com/v1");
  });
});
