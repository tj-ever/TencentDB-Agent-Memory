import { ApiError, request } from '@/lib/api/base';
import type { MetaEnvelope } from '@/lib/api/types';
import { getPanelSession } from '@/lib/panelSession';

/** 自定义接口统一复用面板会话头和 envelope 解包。 */
export async function customRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>(method, path, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}
