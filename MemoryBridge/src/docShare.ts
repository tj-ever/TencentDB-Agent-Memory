const API = 'https://open.feishu.cn/open-apis';

const PUBLIC_BODY = {
  external_access: true,
  link_share_entity: 'anyone_editable',
  security_entity: 'anyone_can_edit',
  comment_entity: 'anyone_can_edit',
  share_entity: 'anyone',
};

// file = 文档里的附件块（/file/<token>），与 docx/sheets 一样需要提权才能被外链用户打开
// （2026-08-30 实测 permission API 对附件 token 接受 type=file）。
const TYPE_RE = /(?:https?:\/\/[^\s)\]>'"]*\/)?(docx|sheets|file)\/([A-Za-z0-9]{20,32})/g;

export interface DriveFile { id: string; type: 'docx' | 'sheet' | 'file'; }

export interface FeishuCreds {
  app_id: string;
  app_secret: string;
}

export function extractDriveFiles(text: string | null | undefined): DriveFile[] {
  if (!text) return [];
  const seen = new Set<string>();
  const files: DriveFile[] = [];
  const re = new RegExp(TYPE_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind = m[1] === 'sheets' ? 'sheet' : (m[1] as DriveFile['type']);
    const key = `${kind}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ id: m[2]!, type: kind });
  }
  return files;
}

export function rewriteFeishuHost(text: string): string {
  return text.replaceAll('https://my.feishu.cn/', 'https://www.feishu.cn/');
}

async function req(method: string, url: string, token: string | null, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json() as Record<string, unknown>;
  // 飞书业务错误在 body.code 里（如 99991672 权限 scope 缺失），HTTP 仍是 200——
  // 不检查的话提权失败会被静默吞掉（2026-09-04 海大文档排查即栽在这）。
  if (typeof out.code === 'number' && out.code !== 0) {
    throw new Error(`feishu ${String(out.code)}: ${String(out.msg ?? '')}`);
  }
  return out;
}

async function tenantToken(feishu: FeishuCreds): Promise<string> {
  const out = await req('POST', `${API}/auth/v3/tenant_access_token/internal`, null, {
    app_id: feishu.app_id,
    app_secret: feishu.app_secret,
  });
  if (!out.tenant_access_token) throw new Error(`token fail: ${String(out.msg ?? out.code)}`);
  return out.tenant_access_token as string;
}

export interface DocShareResult {
  id: string;
  type: 'docx' | 'sheet' | 'file';
  user?: unknown;
  chat?: unknown;
  public?: unknown;
}

export async function openDocsFromText(
  text: string,
  feishu: FeishuCreds,
  { openId, chatId }: { openId?: string; chatId?: string } = {},
): Promise<DocShareResult[]> {
  const files = extractDriveFiles(text);
  if (!files.length) return [];
  const token = await tenantToken(feishu);
  const results: DocShareResult[] = [];
  for (const { id, type } of files) {
    const row: DocShareResult = { id, type };
    // 逐个文件兜错：打字机流式期间会先匹配到 20+ 字符的半截 token，那些调用必然
    // 报「文档不存在」；一个失败不能中断后面（最终全文会再提权一次）。
    try {
      if (openId) {
        row.user = await req('POST', `${API}/drive/v1/permissions/${id}/members?type=${type}`, token, {
          member_type: 'openid',
          member_id: openId,
          perm: 'edit',
          type: 'user',
        });
      }
      if (chatId) {
        row.chat = await req('POST', `${API}/drive/v1/permissions/${id}/members?type=${type}`, token, {
          member_type: 'openchat',
          member_id: chatId,
          perm: 'edit',
          type: 'chat',
        });
      }
      row.public = await req('PATCH', `${API}/drive/v1/permissions/${id}/public?type=${type}`, token, PUBLIC_BODY);
    } catch (err) {
      console.error(`[doc-share] 提权失败 ${type}/${id}:`, err instanceof Error ? err.message : String(err));
    }
    results.push(row);
  }
  return results;
}
