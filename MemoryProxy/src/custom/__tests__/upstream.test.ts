import { describe, expect, it } from "vitest";
import { parseUpstreamAgents, resolveUpstreamRoute, type UpstreamRoute } from "../upstream.js";
import type { AgentUpstreamEntry, ProxyConfig } from "../../types.js";

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
