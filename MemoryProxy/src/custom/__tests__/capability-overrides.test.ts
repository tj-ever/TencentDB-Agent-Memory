import { describe, it, expect } from "vitest";
import { renderSkillToolsBlock } from "../../injection/injectors/skill-tools-injector.js";
import { renderTdaiMemoryToolsBlock } from "../../injection/injectors/tdai-tools-injector.js";
import { renderKnowledgeToolsBlock } from "../../injection/injectors/knowledge-tools-injector.js";
import { wrapAvailableSkillsBlock } from "../../injection/injectors/skill-injector.js";
import { TdaiProfileMemoryInjector } from "../../injection/injectors/tdai-profile-memory-injector.js";
import { MEMORY_TOOLS_GUIDE } from "../../injection/injectors/tdai-profile-memory-injector.js";
import type { CapabilityStore } from "../capability-store.js";
import type { KnowledgeItem } from "../../knowledge/core-client.js";

const RES: KnowledgeItem[] = [
  {
    knowledge_id: "k1",
    type: "wiki",
    service_url: "http://x/wiki/1",
    name: "wiki一",
    summary: "设计说明",
    team_id: "t1",
    user_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  },
];

describe("话术槽覆盖渲染（二开能力中心）", () => {
  describe("skill-tools-injector 整块覆盖", () => {
    it("传 overrideBlock → 原样返回覆盖文本，不渲染默认 curl 教程", () => {
      const out = renderSkillToolsBlock("http://127.0.0.1:8096/", true, "sid1", undefined, "MY SKILL TOOLS BLOCK");
      expect(out).toBe("MY SKILL TOOLS BLOCK");
    });
    it("不传 override → 渲染默认块且含工具名", () => {
      const out = renderSkillToolsBlock("http://127.0.0.1:8096/");
      expect(out).toContain("<skill_tools>");
      expect(out).toContain("skill_search");
    });
  });

  describe("tdai-tools-injector 整块覆盖", () => {
    it("传 overrideBlock → 原样返回", () => {
      expect(renderTdaiMemoryToolsBlock("http://b", "s", "sp", "MY TD TOOLS")).toBe("MY TD TOOLS");
    });
    it("不传 → 渲染默认块", () => {
      expect(renderTdaiMemoryToolsBlock("http://b", "s", "sp")).toContain("<tdai_memory_tools>");
    });
  });

  describe("knowledge-tools-injector 整块覆盖 + {resources} 占位", () => {
    it("override 含 {resources} 占位 → 替换为资源标签段", () => {
      const out = renderKnowledgeToolsBlock(RES, "svc", {}, "MY {resources} WRAPPER");
      expect(out).toContain("MY ");
      expect(out).toContain("WRAPPER");
      expect(out).toContain(`name="wiki一"`);
    });
    it("override 不含占位 → 整块替换（不渲染资源）", () => {
      expect(renderKnowledgeToolsBlock(RES, "svc", {}, "MY STATIC")).toBe("MY STATIC");
    });
    it("无 override → 渲染默认块", () => {
      expect(renderKnowledgeToolsBlock(RES, "svc")!).toContain("<knowledge_tools>");
    });
    it("resources 为空 → 返回 null（两种路径均不发块）", () => {
      expect(renderKnowledgeToolsBlock([], "svc", {}, "OVERRIDE")).toBeNull();
    });
  });

  describe("skill-injector header/footer 各自覆盖", () => {
    it("只覆盖 header → footer 用默认", () => {
      const out = wrapAvailableSkillsBlock("LISTING", { header: "MY HEADER" });
      expect(out.startsWith("MY HEADER")).toBe(true);
      expect(out).toContain("Only proceed without loading a skill");
    });
    it("只覆盖 footer → header 用默认", () => {
      const out = wrapAvailableSkillsBlock("LISTING", { footer: "MY FOOTER" });
      expect(out.endsWith("MY FOOTER")).toBe(true);
      expect(out).toContain("## Skills (mandatory)");
    });
    it("不传 overrides → 默认 header+footer", () => {
      const out = wrapAvailableSkillsBlock("LISTING");
      expect(out).toContain("## Skills (mandatory)");
      expect(out).toContain("Only proceed without loading a skill");
    });
  });

  describe("tdai-profile-memory-injector guide 覆盖", () => {
    /** guide 是 private getter（TS 编译期私有、运行期可读），做只读验证。 */
    function readGuide(inj: TdaiProfileMemoryInjector): string {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inj), "guide")!;
      return (desc.get!.call(inj)) as string;
    }

    it("capStore 命中且 enabled → guide 用覆盖文本", () => {
      const store: CapabilityStore = {
        getCapability: () => ({ enabled: true, text: "MY GUIDE TEXT" }),
      };
      const inj = new TdaiProfileMemoryInjector({} as never, null, store);
      expect(readGuide(inj)).toBe("MY GUIDE TEXT");
    });

    it("capStore 未命中 / enabled=false → guide 回退默认 MEMORY_TOOLS_GUIDE", () => {
      const absent: CapabilityStore = { getCapability: () => undefined };
      expect(readGuide(new TdaiProfileMemoryInjector({} as never, null, absent))).toBe(MEMORY_TOOLS_GUIDE);

      const disabled: CapabilityStore = { getCapability: () => ({ enabled: false, text: "SHOULD NOT" }) };
      expect(readGuide(new TdaiProfileMemoryInjector({} as never, null, disabled))).toBe(MEMORY_TOOLS_GUIDE);
    });
  });
});