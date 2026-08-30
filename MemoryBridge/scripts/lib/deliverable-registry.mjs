// 交付物注册表：publish-doc / embed-prototype 成功后自动登记到 $FEISHU_DELIVERABLES。
// 目的：迭代请求能路由回原文档（doc_id / 块 id），消灭同标题文档增殖。
// 条目：{ ts, kind: 'doc'|'embed', title, doc_id, url, blocks?, html?, image_block_id?, html_block_id? }
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function loadDeliverables() {
  const path = process.env.FEISHU_DELIVERABLES;
  if (!path || !existsSync(path)) return [];
  try {
    const list = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function registerDeliverable(entry) {
  const path = process.env.FEISHU_DELIVERABLES;
  if (!path) return; // 未配置注册表（如本地手动测试）时静默跳过
  let list = [];
  try {
    if (existsSync(path)) list = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch { /* 损坏则重建 */ }
  list.push({ ts: new Date().toISOString(), ...entry });
  writeFileSync(path, JSON.stringify(list, null, 2));
}
