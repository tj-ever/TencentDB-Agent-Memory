// publish-doc.mjs - 把 markdown 方案正文规范化发布成飞书 docx 文档。
// 用法：node publish-doc.mjs <md_path> [--title 标题] [--doc-id 已有文档id] [--fresh]
//
// 背景：方案正文此前由 agent 每场会话现写脚本发布，长文档常被 Bash 超时砍成半成品、
// 或 block schema 拼错产出空块。本脚本收敛这条链路：
//   - markdown 子集：# 标题 / 段落 / 无序有序清单 / 任务 / 代码块 / 引用(降级斜体) / 表格 / 分割线
//   - 分批发布（40 块/批），每批/每表完成后写断点状态 <md>.publish.json，失败重跑同命令即续传
//   - 表格按实测过的 4 步建：建 31 空表 → 取 cell id → 取 cell 内 text 块 → PATCH update_text
//     （update_text 必须带 style+fields，否则 99992402）
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const API = 'https://open.feishu.cn/open-apis';
const BATCH = 40; // 单批 children 上限（skill 实测 ~40 稳妥）

// ---------- CLI ----------
const argv = process.argv.slice(2);
const mdPath = argv.find((a) => !a.startsWith('--'));
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!mdPath) {
  console.error('usage: publish-doc.mjs <md_path> [--title 标题] [--doc-id 已有文档id] [--fresh]');
  process.exit(1);
}
if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  console.error('need FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}
const fresh = argv.includes('--fresh');
const statePath = resolve(mdPath) + '.publish.json';

// ---------- 飞书 API ----------
async function tenantToken() {
  const j = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  }).then((r) => r.json());
  if (!j.tenant_access_token) throw new Error(`token: ${JSON.stringify(j)}`);
  return j.tenant_access_token;
}

async function api(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  if (r.code !== 0) throw new Error(`${method} ${path}: ${JSON.stringify(r).slice(0, 300)}`);
  return r.data;
}

// ---------- markdown 解析 ----------
function plain(text) {
  return { text_run: { content: text } };
}

// 行内样式：**粗** *斜* `码` [字](链接)
function parseRuns(text) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(plain(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) runs.push({ text_run: { content: tok.slice(2, -2), text_element_style: { bold: true } } });
    else if (tok.startsWith('`')) runs.push({ text_run: { content: tok.slice(1, -1), text_element_style: { inline_code: true } } });
    else if (tok.startsWith('[')) {
      const mm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok);
      runs.push({ text_run: { content: mm[1], text_element_style: { link: { url: mm[2] } } } });
    } else runs.push({ text_run: { content: tok.slice(1, -1), text_element_style: { italic: true } } });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push(plain(text.slice(last)));
  return runs.length ? runs : [plain('')];
}

// 逐行解析成发布单元：普通块攒成 batch 单元，表格单独成单元
function parseMd(md) {
  const lines = md.split('\n');
  const units = [];
  let batch = [];
  let i = 0;

  const flush = () => {
    if (batch.length) { units.push({ kind: 'batch', blocks: batch }); batch = []; }
  };
  const push = (block) => {
    batch.push(block);
    if (batch.length >= BATCH) flush();  // children 单批上限 50（99992402），留余量切 40
  };

  while (i < lines.length) {
    const line = lines[i];

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = h[1].length;
      push({ block_type: 2 + lv, [`heading${lv}`]: { elements: parseRuns(h[2]) } });
      i += 1;
      continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      push({ block_type: 22, divider: {} });  // 实测 key 是 divider，不是 horizontal
      i += 1;
      continue;
    }
    const todo = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      push({ block_type: 17, todo: { style: { done: todo[1].toLowerCase() === 'x' }, elements: parseRuns(todo[2]) } });
      i += 1;
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      push({ block_type: 12, bullet: { elements: parseRuns(bullet[1]) } });
      i += 1;
      continue;
    }
    const ord = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ord) {
      push({ block_type: 13, ordered: { elements: parseRuns(ord[1]) } });
      i += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      // 引用块创建需要 34 容器 + 子块两跳，方案文档里是装饰性内容，降级为斜体段落
      push({ block_type: 2, text: { elements: [{ text_run: { content: quote[1], text_element_style: { italic: true } } }] } });
      i += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) { body.push(lines[i]); i += 1; }
      i += 1;
      // 1 = PlainText；代码高亮枚举拿不准时不猜，纯文本最稳
      push({ block_type: 14, code: { language: 1, elements: [plain(body.join('\n') || ' ')] } });
      void lang;
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i += 1;
      }
      rows.splice(1, 1); // 第二行是 |---|---| 分隔行，不是数据
      flush();
      units.push({ kind: 'table', rows });
      continue;
    }
    if (line.trim() === '') { i += 1; continue; }
    push({ block_type: 2, text: { elements: parseRuns(line) } });
    i += 1;
  }
  flush();
  return units;
}

// ---------- 发布 ----------
async function publishBatch(tok, docId, blocks) {
  await api(tok, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: blocks });
}

async function publishTable(tok, docId, rows) {
  const colSize = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(colSize - r.length).fill('')]);
  const created = await api(tok, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, {
    children: [{ block_type: 31, table: { property: { row_size: norm.length, column_size: colSize } } }],
  });
  const tableBlock = created.children[0];
  const cellIds = tableBlock.children || tableBlock.table?.cells || [];
  if (cellIds.length !== norm.length * colSize) {
    throw new Error(`table cells ${cellIds.length} != ${norm.length * colSize}`);
  }
  try {
    // 单元格文本逐个 PATCH；update_text 必须带 style+fields（缺一报 99992402）
    for (let c = 0; c < cellIds.length; c++) {
      const cell = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${cellIds[c]}`);
      const textId = cell.block.children[0];
      if (!textId) throw new Error(`cell ${cellIds[c]} has no text child`);
      await api(tok, 'PATCH', `/docx/v1/documents/${docId}/blocks/${textId}`, {
        update_text: {
          style: { align: 1 },
          fields: [1],
          elements: [plain(norm[Math.floor(c / colSize)][c % colSize])],
        },
      });
    }
  } catch (err) {
    // 半成品表格回滚删块，重跑时重建，不留空格子表
    try { await api(tok, 'DELETE', `/docx/v1/documents/${docId}/blocks/${tableBlock.block_id}`); } catch { /* best-effort */ }
    throw err;
  }
  return tableBlock.block_id;
}

// 数文档根级块总数（分页）。续传对账用。
async function countChildren(tok, docId) {
  let n = 0;
  let pageToken = '';
  for (;;) {
    const d = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${docId}/children?page_size=200${pageToken}`);
    n += d.items.length;
    if (!d.page_token || !d.has_more) return n;
    pageToken = `&page_token=${d.page_token}`;
  }
}

// ---------- 主流程（断点续传）----------
const md = readFileSync(mdPath, 'utf8');
const units = parseMd(md);
const defaultTitle = (/^#\s+(.+)$/m.exec(md) || [, basename(mdPath).replace(/\.md$/i, '')])[1];
const unitBlocks = (u) => (u.kind === 'table' ? 1 : u.blocks.length);

const tok = await tenantToken();

let state = null;
if (!fresh && existsSync(statePath)) {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
}
const overrideId = opt('doc-id');
let docId = overrideId || state?.doc_id;
if (!docId) {
  const doc = await api(tok, 'POST', '/docx/v1/documents', { title: opt('title') || defaultTitle });
  docId = doc.document.document_id;
  state = { doc_id: docId, next: 0 };
  writeFileSync(statePath, JSON.stringify(state));
  console.error(`[publish] 新建文档 ${docId}`);
} else if (overrideId && state?.doc_id !== overrideId) {
  state = { doc_id: overrideId, next: 0 };
  console.error(`[publish] 追加到指定文档 ${overrideId}`);
}

let next = state?.next || 0;
if (next > 0) {
  // 对账：「先发布后写断点」存在崩溃窗口——上次的单元可能已上到服务端但状态没落盘，
  // 直接续传会重复发布。数实际块数比期望多出恰好一个单元 → 视为已发布，跳过它。
  const expected = units.slice(0, next).reduce((n, u) => n + unitBlocks(u), 0);
  const actual = await countChildren(tok, docId);
  if (actual === expected + unitBlocks(units[next])) {
    console.error(`[publish] 对账：检测到断点窗口重复发布（实际 ${actual} > 期望 ${expected}），跳过已上送的单元`);
    next += 1;
    writeFileSync(statePath, JSON.stringify({ doc_id: docId, next }));
  } else if (actual !== expected) {
    // 对不上账（多了不完整的单元或人为编辑过）：不盲目续传，交给人决定
    console.error(`[publish] 对账失败：文档实际 ${actual} 块，断点期望 ${expected} 块。文档可能被手动编辑过，请检查后用 --doc-id 重发。`);
    process.exit(1);
  }
  console.error(`[publish] 断点续传：从第 ${next}/${units.length} 单元继续`);
}
for (; next < units.length; next++) {
  const u = units[next];
  if (u.kind === 'batch') await publishBatch(tok, docId, u.blocks);
  else await publishTable(tok, docId, u.rows);
  // 每单元落盘断点：崩在这里重跑即从本单元继续
  writeFileSync(statePath, JSON.stringify({ doc_id: docId, next: next + 1 }));
  console.error(`[publish] ${next + 1}/${units.length} 单元完成（${u.kind === 'table' ? `表格 ${u.rows.length}行` : `${u.blocks.length} 块`}）`);
}

unlinkSync(statePath); // 全部发布完成，清掉断点文件
const blockCount = units.reduce((n, u) => n + (u.kind === 'table' ? 1 : u.blocks.length), 0);
console.log(JSON.stringify({
  ok: true,
  doc_id: docId,
  url: `https://my.feishu.cn/docx/${docId}`,
  units: units.length,
  blocks: blockCount,
}));
