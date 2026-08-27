import { describe, expect, it } from "vitest";
import {
  isAgentBindingAuthorized,
  parseUpstreamAgents,
  resolveMemoryIdentity,
  resolveUpstreamRoute,
  type UpstreamRoute,
} from "../upstream.js";
import type { AgentUpstreamEntry, ProxyConfig } from "../../types.js";

function route(entry: AgentUpstreamEntry | undefined, spaceInPath = "spc-path"): UpstreamRoute {
  const cfg = { upstream: { url: "https://default.example.com/v1", agents: entry ? { fw1: entry } : {} } } as unknown as ProxyConfig;
  return resolveUpstreamRoute(cfg, `/fw1/${spaceInPath}`);
}

interface RawEntry {
  url?: string;
  model?: string;
  binding?: { team_id?: string; agent_id?: string };
  memory?: { key?: string; spaceId?: string };
}

function parseEntry(entry: RawEntry): AgentUpstreamEntry | undefined {
  const raw = { url: "http://x/x", ...entry } as NonNullable<Parameters<typeof parseUpstreamAgents>[0]>["fw1"];
  return parseUpstreamAgents({ fw1: raw }).fw1;
}

describe("resolveMemoryIdentity", () => {
  it("命中带 memory 的 agent → 用 agent key + space，isAgent=true", () => {
    const r = route({ url: "https://dev.example.com/v1", memory: { key: "sk-mem-agent", spaceId: "spc-agent" } });
    const out = resolveMemoryIdentity(r, "sk-mem-dev", "", "spc-path");
    expect(out).toEqual({ memoryKey: "sk-mem-agent", spaceId: "spc-agent", isAgent: true });
  });

  it("memory 无 spaceId → 回退 pathSpaceId", () => {
    const r = route({ url: "https://dev.example.com/v1", memory: { key: "sk-mem-agent" } });
    const out = resolveMemoryIdentity(r, "sk-mem-dev", "", "spc-path");
    expect(out).toEqual({ memoryKey: "sk-mem-agent", spaceId: "spc-path", isAgent: true });
  });

  it("无 memory 配置 → 回退 header||apiKey，isAgent=false", () => {
    const r = route({ url: "https://dev.example.com/v1", binding: { team_id: "t", agent_id: "a" } });
    const out = resolveMemoryIdentity(r, "sk-mem-dev", "", "spc-path");
    expect(out).toEqual({ memoryKey: "sk-mem-dev", spaceId: "spc-path", isAgent: false });
  });

  it("无 memory 且无 header → 回退模型 apiKey", () => {
    const r = route({ url: "https://dev.example.com/v1" });
    const out = resolveMemoryIdentity(r, "", "sk-model", "spc-path");
    expect(out).toEqual({ memoryKey: "sk-model", spaceId: "spc-path", isAgent: false });
  });
});

describe("parseUpstreamAgents", () => {
  it("memory 字段收敛透传", () => {
    const entry = parseEntry({ url: "https://dev.example.com/v1", model: "m", memory: { key: "sk-mem-agent", spaceId: "spc-agent" }, binding: { team_id: "t", agent_id: "a" } });
    expect(entry).toEqual({ url: "https://dev.example.com/v1", model: "m", binding: { team_id: "t", agent_id: "a" }, memory: { key: "sk-mem-agent", spaceId: "spc-agent" } });
  });

  it("memory 缺 key 时不产出 memory", () => {
    const entry = parseEntry({ url: "https://dev.example.com/v1", memory: { spaceId: "spc-x" } });
    expect(entry?.memory).toBeUndefined();
  });
});

describe("isAgentBindingAuthorized", () => {
  it("带 memory 的 agent → 短路授权 true（不校验开发者团队资格）", async () => {
    const r = route({ url: "https://dev.example.com/v1", memory: { key: "sk-mem-agent" } });
    const cfg = {} as unknown as ProxyConfig;
    await expect(isAgentBindingAuthorized(r, "", "", cfg)).resolves.toBe(true);
  });
});
