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
import { registerDeliverable } from './lib/deliverable-registry.mjs';

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

// 拉全文档根级块（分页）。对账/自检共用。
async function fetchRootChildren(tok, docId) {
  const items = [];
  let pageToken = '';
  for (;;) {
    const d = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${docId}/children?page_size=200${pageToken}`);
    items.push(...d.items);
    if (!d.page_token || !d.has_more) return items;
    pageToken = `&page_token=${d.page_token}`;
  }
}

// 发布后全量自检：块数=预期、表格无空格子。不过关不登记注册表、不报成功。
async function verifyPublished(tok, docId, expectedBlocks) {
  const errors = [];
  const items = await fetchRootChildren(tok, docId);
  const tableCellIds = items.filter((b) => b.block_type === 31).flatMap((b) => b.children || []);
  if (expectedBlocks !== null && items.length !== expectedBlocks) {
    errors.push(`块数不符：实际 ${items.length}，预期 ${expectedBlocks}`);
  }
  let emptyCells = 0;
  for (const cid of tableCellIds) {
    const cell = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${cid}`);
    const textId = cell.block.children?.[0];
    if (!textId) { emptyCells += 1; continue; }
    const tb = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${textId}`);
    const txt = (tb.block.text?.elements || []).map((e) => e.text_run?.content || '').join('');
    if (!txt.trim()) emptyCells += 1;
  }
  if (emptyCells) errors.push(`表格空格子 ${emptyCells} 个`);
  return { blocks: items.length, tables: tableCellIds.length > 0 ? items.filter((b) => b.block_type === 31).length : 0, empty_cells: emptyCells, errors };
}

// 网络级失败（fetch reject：断连/超时/重置）自动重试一次；API 业务错误不重试——
// 业务错误多半已上送成功或参数有误，盲目重试会重复发布（有对账兜底但别主动踩）。
async function withNetRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!/fetch failed|network|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(err?.message ?? err))) throw err;
    console.error(`[publish] 网络错误，2s 后重试一次：${String(err?.message ?? err).slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 2000));
    return fn();
  }
}

// ---------- 结构校验：--schema '["背景","方案",…]' ----------
// 发布前核对 md 里出现过哪些必备章节（任意层级标题，子串包含匹配），缺章节直接拒绝，
// 避免半篇方案被发布出去。惯例章节集写进 workspace 技能文档，agent 调用时带上。
function validateSchema(md) {
  const schemaArg = opt('schema');
  if (!schemaArg) return;
  let required;
  try { required = JSON.parse(schemaArg); } catch { console.error('--schema 需要 JSON 数组，如 \'["背景","方案"]\''); process.exit(1); }
  if (!Array.isArray(required) || !required.length) { console.error('--schema 需要非空 JSON 数组'); process.exit(1); }
  const headings = [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim());
  const missing = required.filter((r) => !headings.some((h) => h.includes(r)));
  if (missing.length) {
    console.error(`[publish] 结构校验未通过，缺少必备章节：${missing.join('、')}。现有章节：${headings.join(' / ') || '（无）'}`);
    process.exit(1);
  }
  console.error(`[publish] 结构校验通过：${required.length} 个必备章节齐全`);
}

// ---------- 主流程（断点续传）----------
const md = readFileSync(mdPath, 'utf8');
validateSchema(md);
const units = parseMd(md);
const defaultTitle = (/^#\s+(.+)$/m.exec(md) || [, basename(mdPath).replace(/\.md$/i, '')])[1];
const unitBlocks = (u) => (u.kind === 'batch' ? u.blocks.length : 1);

const tok = await tenantToken();

// ---------- 尾部重建辅助（--update-section 用）----------
// 背景：children 创建接口的 ?index= 实测无效（一律追加到文档末尾，2026-08-31 实证），
// 原位插入不可行。可行方案 = 「删锚点起全部内容 → 依序追加 新段 + 重建尾部」。
// 纯文本/表格直接重建；图片/附件块走「下载媒体 → 建空块 → 重传 → 重绑」
// （同一 token 不能绑到第二个块，1770013 relation mismatch；块删除后媒体仍可下载）。

const BLOCK_KEY = {
  2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4',
  7: 'heading5', 8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9',
  12: 'bullet', 13: 'ordered', 14: 'code', 17: 'todo',
};

async function downloadMedia(tok, token) {
  const r = await fetch(`${API}/drive/v1/medias/${token}/download`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`下载媒体 ${token} 失败: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadBytes(tok, parentType, parentNode, name, buf) {
  const form = new FormData();
  form.set('file_name', name);
  form.set('parent_type', parentType);
  form.set('parent_node', parentNode);
  form.set('size', String(buf.length));
  form.set('file', new Blob([buf]), name);
  const up = await fetch(`${API}/drive/v1/medias/upload_all`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: form,
  }).then((r) => r.json());
  if (up.code !== 0) throw new Error(`上传 ${name}: ${JSON.stringify(up).slice(0, 200)}`);
  return up.data.file_token;
}

// 重建图片块：建空块 → 重传下载到的字节 → replace_image → 验证 token 非空
async function rebuildImage(tok, docId, u) {
  const buf = await downloadMedia(tok, u.token);
  const created = await api(tok, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: [{ block_type: 27, image: {} }] });
  const imgId = created.children[0].block_id;
  try {
    const fileToken = await uploadBytes(tok, 'docx_image', imgId, u.name, buf);
    await api(tok, 'PATCH', `/docx/v1/documents/${docId}/blocks/${imgId}`, { replace_image: { token: fileToken } });
    const b = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${imgId}`);
    if (!b.block?.image?.token) throw new Error('图片块重绑后 token 为空');
  } catch (err) {
    try { await api(tok, 'DELETE', `/docx/v1/documents/${docId}/blocks/${imgId}`); } catch { /* best-effort */ }
    throw err;
  }
}

// 重建附件块：建 {23,file}（返回 33 view 容器，真正 file 块是第一个子块）→ 重传 → replace_file
async function rebuildFile(tok, docId, u) {
  const buf = await downloadMedia(tok, u.token);
  const created = await api(tok, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: [{ block_type: 23, file: {} }] });
  let fileBlock = created.children.find((b) => b.block_type === 23);
  if (!fileBlock) {
    const view = created.children[0];
    const innerId = view?.children?.[0];
    if (!innerId) throw new Error(`附件块结构异常: ${JSON.stringify(created).slice(0, 200)}`);
    fileBlock = { block_id: innerId };
  }
  try {
    const fileToken = await uploadBytes(tok, 'docx_file', fileBlock.block_id, u.name, buf);
    await api(tok, 'PATCH', `/docx/v1/documents/${docId}/blocks/batch_update`, { requests: [{ block_id: fileBlock.block_id, replace_file: { token: fileToken } }] });
    const b = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${fileBlock.block_id}`);
    if (!b.block?.file?.token) throw new Error('附件块重绑后 token 为空');
  } catch (err) {
    try { await api(tok, 'DELETE', `/docx/v1/documents/${docId}/blocks/${created.children[0].block_id}`); } catch { /* best-effort */ }
    throw err;
  }
}

// 把根级块快照成可重建单元（JSON 可序列化，媒体只存 token，追加时再下载重传）。
// 不支持的块类型（callout/引用容器等，本发布器从不产出）直接报错，让调用方改走整篇重发。
async function snapshotTrailing(tok, docId, blocks) {
  const units = [];
  let batch = [];
  const flush = () => {
    if (batch.length) { units.push({ kind: 'batch', blocks: batch }); batch = []; }
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.block_type === 31) {
      flush();
      const cellIds = b.children || [];
      const cols = b.table?.property?.column_size || 1;
      const cells = [];
      for (const cid of cellIds) {
        const cell = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${cid}`);
        let txt = '';
        for (const tid of cell.block.children || []) {
          const tb = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${tid}`);
          txt += (tb.block.text?.elements || []).map((e) => e.text_run?.content || '').join('');
        }
        cells.push(txt);
      }
      const rows = [];
      for (let r = 0; r < cells.length / cols; r++) rows.push(cells.slice(r * cols, (r + 1) * cols));
      units.push({ kind: 'table', rows });
    } else if (b.block_type === 27) {
      flush();
      if (!b.image?.token) throw new Error(`第 ${i} 块图片无 token`);
      units.push({ kind: 'image', token: b.image.token, name: `image-${units.length}.png` });
    } else if (b.block_type === 23 || b.block_type === 33) {
      flush();
      const fileId = b.block_type === 23 ? b.block_id : (b.children || [])[0];
      if (!fileId) throw new Error(`第 ${i} 块附件结构异常`);
      const fb = await api(tok, 'GET', `/docx/v1/documents/${docId}/blocks/${fileId}`);
      if (!fb.block?.file?.token) throw new Error(`第 ${i} 块附件无 token`);
      units.push({ kind: 'file', token: fb.block.file.token, name: fb.block.file.name || `file-${units.length}` });
    } else {
      const key = BLOCK_KEY[b.block_type];
      if (!key) throw new Error(`尾部第 ${i} 块类型 ${b.block_type} 不支持原地重建（手动编辑过的复杂块），请改用整篇重发`);
      const body = b[key];
      const rebuilt = { block_type: b.block_type, [key]: { elements: body?.elements || [] } };
      if (body?.style) rebuilt[key].style = body.style;
      batch.push(rebuilt);
      if (batch.length >= BATCH) flush();
    }
  }
  flush();
  return units;
}

async function appendUnit(tok, docId, u) {
  if (u.kind === 'batch') return publishBatch(tok, docId, u.blocks);
  if (u.kind === 'table') return publishTable(tok, docId, u.rows);
  if (u.kind === 'image') return rebuildImage(tok, docId, u);
  return rebuildFile(tok, docId, u);
}

// md 只放替换后的该段内容（以锚点标题开头）。流程：定位锚点标题 → 快照尾部块 →
// 删锚点起全部内容 → 依序追加 新段 + 重建尾部（带断点）。
// （children 创建接口 ?index= 实测无效——一律追加末尾，2026-08-31 实证，故走全量重建。）
const updateSection = opt('update-section');
if (updateSection) {
  if (!opt('doc-id')) {
    console.error('--update-section 必须配合 --doc-id 使用（在原文档上改，不新建）');
    process.exit(1);
  }
  const uDocId = opt('doc-id');
  let uState = null;
  if (!fresh && existsSync(statePath)) {
    try { uState = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* 忽略 */ }
    if (uState?.mode !== 'update' || uState?.doc_id !== uDocId) uState = null;
  }
  const sectionUnits = units;
  if (!sectionUnits.length) {
    console.error('md 内容为空，没有可更新的段落');
    process.exit(1);
  }

  let appendUnits;   // 依序追加的完整单元序列：新段 + 重建尾部
  let expectedTotal;
  if (uState) {
    appendUnits = uState.append_units;
    expectedTotal = uState.expected_total;
    if (!Array.isArray(appendUnits)) { console.error('断点状态损坏，加 --fresh 重来'); process.exit(1); }
    console.error(`[publish] 断点续传：从第 ${uState.next}/${appendUnits.length} 单元继续`);
  } else {
    // 1) 定位锚点标题（文本完全匹配；列表接口不带文本时逐块 GET）
    // heading 块的字段 key 是 heading1..heading9（block_type-2），没有通用 heading key。
    const headingText = async (b) => {
      const key = `heading${b.block_type - 2}`;
      const els = b[key]?.elements || (await api(tok, 'GET', `/docx/v1/documents/${uDocId}/blocks/${b.block_id}`)).block?.[key]?.elements || [];
      return els.map((e) => e.text_run?.content || '').join('').trim();
    };
    const children = await fetchRootChildren(tok, uDocId);
    let anchor = -1;
    let level = 0;
    for (let i = 0; i < children.length; i++) {
      const b = children[i];
      if (b.block_type < 3 || b.block_type > 8) continue;
      const text = await headingText(b);
      if (text === updateSection.trim()) { anchor = i; level = b.block_type - 2; break; }
    }
    if (anchor < 0) {
      const heads = [];
      for (const b of children) {
        if (b.block_type >= 3 && b.block_type <= 8 && heads.length < 30) {
          const els = b[`heading${b.block_type - 2}`]?.elements || [];
          heads.push(els.map((e) => e.text_run?.content || '').join(''));
        }
      }
      console.error(`[publish] 找不到锚点标题「${updateSection}」。文档现有标题：\n  ${heads.filter(Boolean).join('\n  ') || '（无）'}`);
      process.exit(1);
    }
    // 2) 章节边界：锚点到下一个同级/更高级标题前；其后全是需要重建的尾部
    let sectionEnd = children.length;
    for (let j = anchor + 1; j < children.length; j++) {
      const bt = children[j].block_type;
      if (bt >= 3 && bt <= 8 && bt - 2 <= level) { sectionEnd = j; break; }
    }
    // 3) 快照尾部块（章节结束处到文档末尾）——删之前把要保留的内容全部读出来
    let tailUnits;
    try {
      tailUnits = await snapshotTrailing(tok, uDocId, children.slice(sectionEnd));
    } catch (err) {
      console.error(`[publish] 尾部快照失败：${err instanceof Error ? err.message : err}`);
      console.error('[publish] 文档尾部含不支持原地重建的块（可能被手动编辑过），请把整篇最新内容重跑发布命令覆盖（不带 --update-section）。');
      process.exit(1);
    }
    // 4) 删锚点起的全部内容（旧章节 + 其后所有块，追加时按序重建回来）
    await api(tok, 'DELETE', `/docx/v1/documents/${uDocId}/blocks/${uDocId}/children/batch_delete`, { start_index: anchor, end_index: children.length });
    // 5) 追加序列 = 新段 + 重建尾部
    appendUnits = [...sectionUnits, ...tailUnits];
    expectedTotal = anchor + sectionUnits.reduce((n, u) => n + unitBlocks(u), 0) + tailUnits.reduce((n, u) => n + unitBlocks(u), 0);
    console.error(`[publish] 已删除旧段落（根级第 ${anchor} 块起共 ${children.length - anchor} 块），追加 ${sectionUnits.length} 个新单元 + 重建 ${tailUnits.length} 个尾部单元`);
    uState = { mode: 'update', doc_id: uDocId, next: 0, expected_total: expectedTotal, append_units: appendUnits };
    writeFileSync(statePath, JSON.stringify(uState));
  }

  // 5) 依序追加（带断点；表/图片/附件挂数会回滚自己，重跑重建）
  for (let n = uState.next; n < appendUnits.length; n++) {
    const u = appendUnits[n];
    await withNetRetry(() => appendUnit(tok, uDocId, u));
    writeFileSync(statePath, JSON.stringify({ ...uState, next: n + 1 }));
    console.error(`[publish] 单元 ${n + 1}/${appendUnits.length} 已追加`);
  }

  const check = await verifyPublished(tok, uDocId, expectedTotal);
  if (check.errors.length) {
    console.error(`[publish] 自检未通过：${check.errors.join('；')}`);
    console.log(JSON.stringify({ ok: false, doc_id: uDocId, updated: updateSection, check }));
    process.exit(1);
  }
  unlinkSync(statePath);
  registerDeliverable({ kind: 'doc-update', doc_id: uDocId, section: updateSection, blocks: expectedTotal, md: basename(mdPath) });
  console.log(JSON.stringify({ ok: true, doc_id: uDocId, url: `https://my.feishu.cn/docx/${uDocId}`, updated: updateSection, blocks: expectedTotal, check }));
  process.exit(0);
}

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
if (next > 0 && next < units.length) {
  // 对账：「先发布后写断点」存在崩溃窗口——上次的单元可能已上到服务端但状态没落盘，
  // 直接续传会重复发布。数实际块数比期望多出恰好一个单元 → 视为已发布，跳过它。
  const expected = units.slice(0, next).reduce((n, u) => n + unitBlocks(u), 0);
  const actual = (await fetchRootChildren(tok, docId)).length;
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
  await withNetRetry(() => (u.kind === 'batch'
    ? publishBatch(tok, docId, u.blocks)
    : publishTable(tok, docId, u.rows)));
  // 每单元落盘断点：崩在这里重跑即从本单元继续
  writeFileSync(statePath, JSON.stringify({ doc_id: docId, next: next + 1 }));
  console.error(`[publish] ${next + 1}/${units.length} 单元完成（${u.kind === 'table' ? `表格 ${u.rows.length}行` : `${u.blocks.length} 块`}）`);
}

// 发布后全量自检：不过关→非零退出，不登记注册表（半成品宁可不给）
const blockCount = units.reduce((n, u) => n + unitBlocks(u), 0);
const check = await verifyPublished(tok, docId, blockCount);
if (check.errors.length) {
  console.error(`[publish] 自检未通过：${check.errors.join('；')}（状态已保留，修复后重跑同命令核对）`);
  console.log(JSON.stringify({ ok: false, doc_id: docId, url: `https://my.feishu.cn/docx/${docId}`, blocks: blockCount, check }));
  process.exit(1);
}
unlinkSync(statePath); // 自检通过，清掉断点文件
registerDeliverable({
  kind: 'doc',
  title: opt('title') || defaultTitle,
  doc_id: docId,
  url: `https://my.feishu.cn/docx/${docId}`,
  blocks: blockCount,
  md: basename(mdPath),
});
console.log(JSON.stringify({
  ok: true,
  doc_id: docId,
  url: `https://my.feishu.cn/docx/${docId}`,
  units: units.length,
  blocks: blockCount,
  check,
}));
