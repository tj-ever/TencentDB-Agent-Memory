/**
 * 二开能力注册表 —— 面板上「二开能力中心」的静态展示数据。
 *
 * 来源：
 * - proxy-talk 条目 id/name/description 对齐 MemoryProxy/custom/capability-defs.ts（唯一事实来源）。
 * - bridge-behavior 条目对齐 MemoryBridge/bridgeConfig.ts 的 BridgeConfig 字段。
 * - program-doc 条目摘录自仓库根《二开说明-AI交付协同平台.md》，变更时须同步该文档。
 *
 * kind==='config' 的可配项当前值来自后端（proxy /v3/config/custom-capabilities、
 * bridge /api/config），登记表只提供元数据与「恢复默认」语义。
 */

export type CapabilityCategory = 'proxy-talk' | 'bridge-behavior' | 'program-doc';

export interface Capability {
  id: string;
  category: CapabilityCategory;
  kind: 'config' | 'doc';
  title: string;
  description: string;
  /** kind==='config' 时必填 */
  configTarget?: 'proxy' | 'bridge';
  /** 是否多行 markdown 文本（vs 单行字符串），仅影响展示 */
  multiline?: boolean;
  /** program-doc 阅读性子页路径 */
  doc?: string;
}

const CONFIG_ITEMS: Capability[] = [
  // ── proxy-talk：6 个注入话术槽 ──────────────────────────────────────
  {
    id: 'skill-injector:header',
    category: 'proxy-talk',
    kind: 'config',
    configTarget: 'proxy',
    title: 'Skill 列表 头部话术',
    description: '“以下是你（当前 agent）自带的云端 skill 列表”上方那段强制加载指令。',
    multiline: true,
  },
  {
    id: 'skill-injector:footer',
    category: 'proxy-talk',
    kind: 'config',
    configTarget: 'proxy',
    title: 'Skill 列表 结尾话术',
    description: '“仅当确实没有 skill 相关时才可跳过加载”结尾提示。',
    multiline: true,
  },
  {
    id: 'skill-tools-injector:block',
    category: 'proxy-talk',
    kind: 'config',
    configTarget: 'proxy',
    title: 'Skill Tools 工具说明块',
    description: '整段 <skill_tools> curl 教程块。覆盖后 base URL 按保存时的代理地址固定。',
    multiline: true,
  },
  {
    id: 'knowledge-tools-injector:block',
    category: 'proxy-talk',
    kind: 'config',
    configTarget: 'proxy',
    title: 'Knowledge Tools 工具说明块',
    description: '整段 <knowledge_tools> 教程块。覆盖文本可放 {resources} 占位符，渲染时替换为已绑定资源列表；不放则整块替换。',
    multiline: true,
  },
  {
    id: 'tdai-tools-injector:block',
    category: 'proxy-talk',
    kind: 'config',
    configTarget: 'proxy',
    title: 'TDAI Memory 工具说明块',
    description: '整段 <tdai_memory_tools> curl 教程块（覆盖后 base URL 固定）。',
    multiline: true,
  },
  {
    id: 'tdai-profile-memory-injector:block',
    category: 'proxy-talk',
    kind: 'config',
    configTarget: 'proxy',
    title: '记忆使用指南块',
    description: '附加的 <memory-tools-guide> 话术（L3/L2 数据块之外的静态使用指南）。',
    multiline: true,
  },
  // ── bridge-behavior：交互行为可配项 ─────────────────────────────────
  {
    id: 'reset_commands',
    category: 'bridge-behavior',
    kind: 'config',
    configTarget: 'bridge',
    title: '会话重置指令词',
    description: '触发会话重置的命令词列表（正则 alternative，大小写不敏感）。缺省用内置默认。',
  },
  {
    id: 'reset_reply_success',
    category: 'bridge-behavior',
    kind: 'config',
    configTarget: 'bridge',
    title: '重置成功回复',
    description: '会话重置成功时机器人的回复文案。',
    multiline: true,
  },
  {
    id: 'reset_reply_empty',
    category: 'bridge-behavior',
    kind: 'config',
    configTarget: 'bridge',
    title: '无会话重置回复',
    description: '用户触发重置但当前无会话记录时的回复文案。',
    multiline: true,
  },
  {
    id: 'help_text',
    category: 'bridge-behavior',
    kind: 'config',
    configTarget: 'bridge',
    title: '帮助文案',
    description: '机器人收到「帮助」时的多行 markdown 说明。',
    multiline: true,
  },
  {
    id: 'queue_notice_template',
    category: 'bridge-behavior',
    kind: 'config',
    configTarget: 'bridge',
    title: '排队提示模板',
    description: '消息排队积压时的提示，`{n}` 占位排队条数。留空回退内置默认。',
  },
  {
    id: 'image_reject_reply',
    category: 'bridge-behavior',
    kind: 'config',
    configTarget: 'bridge',
    title: '图片拒收回复',
    description: '模型不支持识图时对图片消息的拒收回复文案。',
    multiline: true,
  },
];

const DOC_ITEMS: Capability[] = [
  {
    id: 'git-askpass',
    category: 'program-doc',
    kind: 'doc',
    title: 'Git 凭证（HTTPS+token）',
    description: '机器人克隆/拉取私有 https 仓库按 host 自动认证，不交互挂起。',
    doc:
      '机器人对话里 git clone/pull 私有 https 仓库（如自建 GitLab）时的按 host 自动认证。\n\n' +
      '· 实现：MemoryBridge/src/gitCreds.ts，启动机器人时按 gits[] 生成 GIT_ASKPASS 脚本（0700，token 只落持久卷，不进 claude 子进程 env）\n' +
      '· 面板 → 飞书机器人 → 编辑 → Git 凭证：按行配置「host + 用户名 + token」，一个机器人可配多行\n' +
      '· 未命中的 host 直接认证失败退出，绝不交互挂起机器人\n' +
      '· 配置为面板密钥，HTTP 返回始终脱敏',
  },
  {
    id: 'mcp-router',
    category: 'program-doc',
    kind: 'doc',
    title: '机器人 MCP（mac-router 等）',
    description: '按 bot 工作目录注入 MCP 工具：MySQL 查询 / 联网搜索。',
    doc:
      '给指定 bot 的对话注入 MCP 工具（MySQL 查询、联网搜索等）。\n\n' +
      '· 方式：在该 bot 工作目录执行 claude mcp add —scope local —— 写入 .claude.json 的 projects[cwd].mcpServers，免审批直接 Connected\n' +
      '· 不要用 .mcp.json 文件：headless 无法交互审批\n' +
      '· 已配置示例：阳光 bot（yangguang）已加 mac-router；/home/node/.claude 是持久卷，容器重建保留\n' +
      '· 移除：同目录 claude mcp remove <name>',
  },
  {
    id: 'publish-doc',
    category: 'program-doc',
    kind: 'doc',
    title: 'publish-doc 飞书文档发布',
    description: '发布交付文档到飞书，长表按块上限自动切分（22 行表发布成功）。',
    doc: '桥接侧交付物发布能力：长表按飞书表格块上限切分，避免单块超限发布失败（见 CHANGELOG 提交 468fb48）。\n\n' +
      '· 面板 → 已交付文档 → 发布到飞书\n' +
      '· 自动处理表格块上限，超长表分块写入',
  },
  {
    id: 'recall-handling',
    category: 'program-doc',
    kind: 'doc',
    title: '用户撤回处理',
    description: '排队中的消息移出；生成中的中止子进程；已回复的保留卡片。',
    doc: '订阅飞书 im.message.recalled_v1 原始事件主动处理撤回：\n\n' +
      '· 排队中：移出队列\n' +
      '· 生成中：中止 claude 子进程并停止打字机\n' +
      '· 已回复完成：保留卡片不动\n' +
      '· 回复目标已撤回导致的开卡失败在生成前快速退出，不浪费上游 token',
  },
  {
    id: 'session-modes',
    category: 'program-doc',
    kind: 'doc',
    title: '会话模式（none/user/chat）',
    description: '机器人会话隔离方式：none=共享、user=按用户、chat=按群。',
    doc: '飞书消息的会话标识使用发送者 open_id，同一机器人按用户隔离对话记忆；会话模式字段见机器人配置 feishu.policy。\n\n' +
      '· none：不注入会话上下文\n' +
      '· user：按发送人隔离\n' +
      '· chat：按群聊隔离',
  },
  {
    id: 'deploy-ci',
    category: 'program-doc',
    kind: 'doc',
    title: '部署 + CI 门禁',
    description: 'deploy/global-images 一键编排；PR 到 main 跑 custom-code 工作流。',
    doc: '· 部署：deploy/global-images/start-all.sh 依次启动 memory-core / memory-hub / proxy，BRIDGE_ENABLED=1 时再启 memory-bridge\n' +
      '· CI：.github/workflows/pr-ci.yml 的 custom-code job —— MemoryBridge typecheck+test 零错误、MemoryProxy 错误数门禁（基线 55）、Panel web typecheck 零错误\n' +
      '· 镜像构建统一 NPM_REGISTRY build-arg + shared-npm-cache mount',
  },
];

/** 直接展示在「对话话术」Tab 的 proxy 槽（与后端 GET 返回顺序一致的备用序）。 */
export const PROXY_TALK_IDS = CONFIG_ITEMS.filter((c) => c.configTarget === 'proxy').map((c) => c.id);

/** 直接展示在「桥接行为」Tab 的 bridge 项。 */
export const BRIDGE_BEHAVIOR_IDS = CONFIG_ITEMS.filter((c) => c.configTarget === 'bridge').map((c) => c.id);

/** kind==='doc' 的只读程序说明（Tab「程序说明」）。 */
export const PROGRAM_DOC_ITEMS: Capability[] = DOC_ITEMS;

export function getCapabilityRegistry(): Capability[] {
  return [...CONFIG_ITEMS, ...DOC_ITEMS];
}