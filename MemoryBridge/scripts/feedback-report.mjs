// feedback-report.mjs - 扫描 workspace 会话记录，统计用户纠错/追问模式，输出改进看板。
// 用法：node feedback-report.mjs <workDir> [--json]
// 数据源：workDir 下的 claude 会话 jsonl（user 短消息即业务反馈一手来源）。
// 目的：让「用户纠正过什么」从一次性对话变成可沉淀的清单，喂回 terminology.md / 技能文档。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = process.argv[2];
const asJson = process.argv.includes('--json');
if (!workDir) {
  console.error('usage: feedback-report.mjs <workDir> [--json]');
  process.exit(1);
}

// 分类规则按实测纠错模式归纳，命中第一个类别即归类（一条消息只算一类，避免重复计数）。
const PATTERNS = [
  { key: '命名纠错', re: /不对|写错|不是.*应该|别叫|改名|字段名|叫错/, desc: '字段/页面命名与用户口径不一致' },
  { key: '口径澄清', re: /我的意思|我是说|换句话说|重新理解|理解错/, desc: '需求被理解偏，需要追问澄清' },
  { key: '交互追问', re: /怎么点|在哪|怎么操作|找不到|没看到/, desc: '原型/文档的交互不够自解释' },
  { key: '内容遗漏', re: /漏了|少了|没加|缺(一|个|项|条)|忘了/, desc: '生成结果缺用户明确列过的项' },
  { key: '格式要求', re: /排版|格式|字号|颜色|对齐|布局/, desc: '展示格式不合用户预期' },
  { key: '重复劳动', re: /重新生成|再来一次|又(生成|发)|每次都/, desc: '同类请求反复重做，缺复用' },
];

const counts = Object.fromEntries(PATTERNS.map((p) => [p.key, 0]));
const samples = Object.fromEntries(PATTERNS.map((p) => [p.key, []]));
let files = 0;
let userMsgs = 0;

for (const f of readdirSync(workDir)) {
  if (!f.endsWith('.jsonl')) continue;
  files += 1;
  for (const line of readFileSync(join(workDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d?.message;
    if (m?.role !== 'user') continue;
    let c = m.content;
    if (Array.isArray(c)) c = c.map((x) => x?.text || '').join(' ');
    c = String(c || '').trim();
    if (!c || c.length > 300 || c.startsWith('<')) continue; // 系统注入/超长内容不算反馈
    userMsgs += 1;
    for (const p of PATTERNS) {
      if (p.re.test(c)) {
        counts[p.key] += 1;
        if (samples[p.key].length < 3) samples[p.key].push(c.slice(0, 80));
        break;
      }
    }
  }
}

const rows = PATTERNS
  .map((p) => ({ key: p.key, desc: p.desc, count: counts[p.key], samples: samples[p.key] }))
  .sort((a, b) => b.count - a.count);

if (asJson) {
  console.log(JSON.stringify({ workDir, files, userMsgs, categories: rows }, null, 2));
  process.exit(0);
}

console.log(`# 反馈回流看板（${workDir}）\n`);
console.log(`会话文件 ${files} 个，用户消息 ${userMsgs} 条（≤300 字的短消息）。\n`);
for (const r of rows) {
  console.log(`## ${r.key}（${r.count} 条）— ${r.desc}`);
  for (const s of r.samples) console.log(`  - ${s}`);
  console.log('');
}
if (!rows.some((r) => r.count > 0)) console.log('暂未识别到纠错类反馈。');
