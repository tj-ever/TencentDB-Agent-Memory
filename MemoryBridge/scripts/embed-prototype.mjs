// embed-prototype.mjs - HTML 截图后插入飞书文档图片块，并在图片后附加可交互 HTML 文件块。
// 用法：node embed-prototype.mjs <document_id> <html_path> [caption]
// 截图用 puppeteer 自带 Chromium（npm install 时下载），不依赖宿主机浏览器。
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const API = 'https://open.feishu.cn/open-apis';

async function tenantToken() {
  const j = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  }).then((r) => r.json());
  if (!j.tenant_access_token) throw new Error(`token: ${JSON.stringify(j)}`);
  return j.tenant_access_token;
}

async function screenshot(htmlPath, pngPath) {
  // 本机跑用 CfT chrome-headless-shell（'shell'）；容器里 PUPPETEER_EXECUTABLE_PATH
  // 指向发行版 chromium，走新 headless。root 容器必须 --no-sandbox。
  const browser = await puppeteer.launch({
    headless: process.env.PUPPETEER_EXECUTABLE_PATH ? true : 'shell',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1440, height: 900 },
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`);
    await page.screenshot({ path: pngPath });
  } finally {
    await browser.close();
  }
}

async function uploadMedia(tok, parentType, parentNode, filePath) {
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.set('file_name', basename(filePath));
  form.set('parent_type', parentType);
  form.set('parent_node', parentNode);
  form.set('size', String(buf.length));
  form.set('file', new Blob([buf]), basename(filePath));
  const uploaded = await fetch(`${API}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}` },
    body: form,
  }).then((r) => r.json());
  if (uploaded.code !== 0) throw new Error(`upload: ${JSON.stringify(uploaded)}`);
  return uploaded.data.file_token;
}

async function insertImage(tok, docId, pngPath, caption) {
  const jsonHeaders = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  const children = [];
  if (caption) {
    children.push({
      block_type: 4,
      heading2: { elements: [{ text_run: { content: caption } }] },
    });
  }
  children.push({ block_type: 27, image: {} });

  const created = await fetch(`${API}/docx/v1/documents/${docId}/blocks/${docId}/children`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ children }),
  }).then((r) => r.json());
  if (created.code !== 0) throw new Error(`create block: ${JSON.stringify(created)}`);

  const imgBlock = created.data.children.find((b) => b.block_type === 27);
  if (!imgBlock) throw new Error(`no image block: ${JSON.stringify(created)}`);

  const fileToken = await uploadMedia(tok, 'docx_image', imgBlock.block_id, pngPath);

  const patched = await fetch(`${API}/docx/v1/documents/${docId}/blocks/${imgBlock.block_id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ replace_image: { token: fileToken } }),
  }).then((r) => r.json());
  if (patched.code !== 0) throw new Error(`patch: ${JSON.stringify(patched)}`);
  return imgBlock.block_id;
}

// 在文档末尾追加一个文件块(block_type=23)，把自包含 HTML 上传并绑定到该块，
// 让用户在交互原型截图之后能点开/下载原始可交互 HTML。
// 序列(与 lark-cli `docs +media-insert --type file` 的 4 步一致)：
//   建空文件块 → medias/upload_all(docx_file) → batch_update replace_file 绑定 token。
async function insertFile(tok, docId, filePath) {
  const jsonHeaders = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${API}/docx/v1/documents/${docId}/blocks/${docId}/children`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ children: [{ block_type: 23, file: {} }] }),
  }).then((r) => r.json());
  if (created.code !== 0) throw new Error(`create file block: ${JSON.stringify(created)}`);
  // API 实际返回的是 33(view) 容器，真正的 file 块是它的第一个子块。
  // 直接拿 view 的 block_id 去 replace_file 会报 1770025 "operation and block not match"，
  // 文档里留下打不开的空壳附件块（2026-08-30 排查实证）。
  let fileBlock = created.data.children.find((b) => b.block_type === 23);
  if (!fileBlock) {
    const innerId = created.data.children[0]?.children?.[0];
    if (!innerId) throw new Error(`no file block: ${JSON.stringify(created)}`);
    fileBlock = { block_id: innerId };
  }

  const fileToken = await uploadMedia(tok, 'docx_file', fileBlock.block_id, filePath);

  const patched = await fetch(`${API}/docx/v1/documents/${docId}/blocks/batch_update`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ requests: [{ block_id: fileBlock.block_id, replace_file: { token: fileToken } }] }),
  }).then((r) => r.json());
  if (patched.code !== 0) throw new Error(`patch file: ${JSON.stringify(patched)}`);
  return fileBlock.block_id;
}

const [docId, htmlArg, caption] = process.argv.slice(2);
if (!docId || !htmlArg) {
  console.error('usage: embed-prototype.mjs <document_id> <html_path> [caption]');
  process.exit(1);
}
if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  console.error('need FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}

const htmlPath = resolve(htmlArg);
const pngPath = htmlPath.replace(/\.html?$/i, '.png');
await screenshot(htmlPath, pngPath);
const tok = await tenantToken();
const blockId = await insertImage(tok, docId, pngPath, caption);
const htmlBlockId = await insertFile(tok, docId, htmlPath);
console.log(JSON.stringify({ ok: true, png: pngPath, block_id: blockId, html_block_id: htmlBlockId, html_name: basename(htmlPath) }));
