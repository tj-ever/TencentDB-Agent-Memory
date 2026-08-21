const API = 'https://open.feishu.cn/open-apis';

const PUBLIC_BODY = {
  external_access: true,
  link_share_entity: 'anyone_editable',
  security_entity: 'anyone_can_edit',
  comment_entity: 'anyone_can_edit',
  share_entity: 'anyone',
};

const TYPE_RE = /(?:https?:\/\/[^\s)\]>'"]*\/)?(docx|sheets)\/([A-Za-z0-9]{20,32})/g;

export interface DriveFile { id: string; type: 'docx' | 'sheet'; }

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
    const kind = m[1] === 'sheets' ? 'sheet' : 'docx';
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
  return res.json() as Promise<Record<string, unknown>>;
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
  type: 'docx' | 'sheet';
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
    results.push(row);
  }
  return results;
}
