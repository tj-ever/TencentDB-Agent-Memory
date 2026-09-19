/**
 * Capability definitions — 二开能力中心的话术槽元数据（id → 名称/说明）。
 *
 * 这里是唯一事实来源：注入器 id 与面板展示文案的对应关系。默认值不在此
 * 冗余存储 —— 未配置覆盖时注入器直接走代码内置默认，面板对 `text: null`
 * 的槽显示「使用代码内置默认」。
 *
 * 面板侧 registry.ts 的 proxy-talk 条目须与本文件 id 保持一致。
 */

export interface CapabilityDef {
  id: string;
  name: string;
  description: string;
}

export const CAPABILITY_DEFS: CapabilityDef[] = [
  {
    id: "skill-injector:header",
    name: "Skill Listing Header",
    description: "「以下是你（当前 agent）自带的云端 skill 列表」上方那段强制加载指令。",
  },
  {
    id: "skill-injector:footer",
    name: "Skill Listing Footer",
    description: "「仅当确实没有 skill 相关时才可跳过加载」结尾提示。",
  },
  {
    id: "skill-tools-injector:block",
    name: "Skill Tools 工具说明块",
    description: "整段 <skill_tools> curl 教程块（覆盖后 base URL 按保存时的代理地址固定）。",
  },
  {
    id: "knowledge-tools-injector:block",
    name: "Knowledge Tools 工具说明块",
    description: "整段 <knowledge_tools> 教程块。覆盖文本中可放 {resources} 占位符，渲染时替换为已绑定资源列表；不放则整块替换。",
  },
  {
    id: "tdai-tools-injector:block",
    name: "TDAI Memory 工具说明块",
    description: "整段 <tdai_memory_tools> curl 教程块（覆盖后 base URL 固定）。",
  },
  {
    id: "tdai-profile-memory-injector:block",
    name: "记忆使用指南块",
    description: "附加的 <memory-tools-guide> 话术（L3/L2 数据块之外的静态使用指南）。",
  },
];

export function getCapabilityDefs(): CapabilityDef[] {
  return CAPABILITY_DEFS;
}
