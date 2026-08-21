// embed-prototype.mjs - HTML 截图后插入飞书文档图片块。
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

  const buf = readFileSync(pngPath);
  const form = new FormData();
  form.set('file_name', basename(pngPath));
  form.set('parent_type', 'docx_image');
  form.set('parent_node', imgBlock.block_id);
  form.set('size', String(buf.length));
  form.set('file', new Blob([buf]), basename(pngPath));

  const up = await fetch(`${API}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}` },
    body: form,
  }).then((r) => r.json());
  if (up.code !== 0) throw new Error(`upload: ${JSON.stringify(up)}`);

  const patched = await fetch(`${API}/docx/v1/documents/${docId}/blocks/${imgBlock.block_id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ replace_image: { token: up.data.file_token } }),
  }).then((r) => r.json());
  if (patched.code !== 0) throw new Error(`patch: ${JSON.stringify(patched)}`);
  return imgBlock.block_id;
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
const blockId = await insertImage(await tenantToken(), docId, pngPath, caption);
console.log(JSON.stringify({ ok: true, png: pngPath, block_id: blockId }));
