import { useEffect, useState } from 'react';
import { Button, Modal, Tag, Text } from 'tea-component';
import { useTranslation } from 'react-i18next';
import type { ChannelBot } from '../api/channels';
import { tea } from '@/lib/tea-bridge';
import { sessionMgmtApi, type BotSessionState } from '../api/session-mgmt';

export function SessionManager({ bot, onClose }: { bot: ChannelBot; onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<BotSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [operating, setOperating] = useState(false);

  async function refresh() {
    setData(await sessionMgmtApi.list(bot.id));
  }

  useEffect(() => {
    setLoading(true);
    void refresh().catch((err) => tea.notify.error(err)).finally(() => setLoading(false));
  }, [bot.id]);

  async function abort() {
    setOperating(true);
    try {
      await sessionMgmtApi.abort(bot.id);
      await refresh();
      tea.notify.success(t('channels.sess.aborted'));
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setOperating(false);
    }
  }

  async function clear(sessionId: string) {
    if (!await tea.confirm({ message: t('channels.sess.clearConfirm', { sid: sessionId }) })) return;
    setOperating(true);
    try {
      await sessionMgmtApi.clear(bot.id, sessionId);
      await refresh();
      tea.notify.success(t('channels.sess.cleared'));
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setOperating(false);
    }
  }

  return (
    <Modal visible caption={`${t('channels.sess.title')} · ${bot.name}`} size="l" onClose={onClose}>
      <Modal.Body>
        {loading ? <Text theme="weak">{t('channels.sess.loading')}</Text> : (
          <>
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <Tag theme={data?.status === 'running' ? 'success' : data?.status === 'error' ? 'error' : 'default'}>
                {data?.status ?? '—'}
              </Tag>
              <Text theme="weak">{t('channels.sess.queueCount', { count: data?.queue.length ?? 0 })}</Text>
              <Button loading={operating} onClick={() => void abort()}>{t('channels.sess.abort')}</Button>
            </div>
            {!!data?.queue.length && (
              <div style={{ marginBottom: 12 }}>
                <Text theme="label">{t('channels.sess.queue')}</Text>
                {data.queue.map((message) => (
                  <Text key={message.id} theme="weak" parent="div" style={{ fontSize: 12, marginTop: 2 }}>
                    {new Date(message.ts).toLocaleTimeString()} · {message.senderName || message.senderId.slice(0, 12)} · {message.image ? t('channels.sess.image') : message.content.slice(0, 40)}
                  </Text>
                ))}
              </div>
            )}
            <Text theme="label">{t('channels.sess.list')}</Text>
            {data?.sessions.length ? data.sessions.map((session) => (
              <div key={session.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <Text style={{ flex: 1, fontSize: 12 }}>{session.userName || session.sessionId.slice(0, 8)}</Text>
                <Text theme="weak" style={{ fontSize: 12 }}>
                  {new Date(session.mtime).toLocaleString()} · {t('channels.sess.lines', { count: session.lines })} · {(session.bytes / 1024).toFixed(1)}KB{session.imageBlocks ? ` · ${t('channels.sess.images', { count: session.imageBlocks })}` : ''}
                </Text>
                <Button loading={operating} onClick={() => void clear(session.sessionId)}>{t('channels.sess.clear')}</Button>
              </div>
            )) : <Text theme="weak">{t('channels.sess.empty')}</Text>}
          </>
        )}
      </Modal.Body>
    </Modal>
  );
}
