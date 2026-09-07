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
  const req = (path: string) => ({ req: { path, header: () => undefined } });

  it("命中 userId：entry 覆盖、apiKey 清空（透传客户端 Key）", async () => {
    const cfg = {
      upstream: {
        url: "https://default.example.com/v1",
        apiKey: "sk-global",
        agents: {},
        userUpstreams: [{ userId: "usr-a", url: "https://byok.example.com/v1" }],
      },
    } as unknown as ProxyConfig;
    const r = await earlyAuth(req("/claude-code/hit"), cfg, "sk-model", errors) as EarlyAuthResult;
    expect(r.upstreamRoute.entry).toEqual({ url: "https://byok.example.com/v1" });
    expect(r.upstreamRoute.apiKey).toBe("");
  });

  it("未命中 userId：走全局兜底", async () => {
    const cfg = {
      upstream: {
        url: "https://default.example.com/v1",
        apiKey: "sk-global",
        agents: {},
        userUpstreams: [{ userId: "usr-a", url: "https://byok.example.com/v1" }],
      },
    } as unknown as ProxyConfig;
    const r = await earlyAuth(req("/claude-code/miss"), cfg, "sk-model", errors) as EarlyAuthResult;
    expect(r.upstreamRoute.entry).toBeUndefined();
    expect(r.upstreamRoute.url).toBe("https://default.example.com/v1");
    expect(r.upstreamRoute.apiKey).toBe("sk-global");
  });
});
