import { useEffect, useState } from 'react';
import {
  Alert,
  Card,
  H3,
  Justify,
  Text,
} from 'tea-component';
import { useTranslation } from 'react-i18next';
import { proxyConfigApi } from '@/custom/api/proxy-config';
import { useCurrentRole } from '@/services/useCurrentRole';
import { tea } from '@/lib/tea-bridge';

/**
 * 开发者配置页（custom: tdai-proxy）
 *
 * 按用户 BYOK 上游绑定已收敛到「API Keys」页（admin 每行「上游配置」），
 * 本页仅回显全局上游与公网接入地址（只读，修改走顶栏⚙设置弹窗的「Proxy 上游」Tab）。
 */
export function SystemConfigPage() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const [pinnedUpstream, setPinnedUpstream] = useState({ url: '', model: '' });

  useEffect(() => {
    if (role !== 'admin') return;
    (async () => {
      try {
        const cur = await proxyConfigApi.get();
        setPinnedUpstream({ url: cur.url, model: cur.model });
      } catch (err) {
        if (err instanceof Error && !String(err.message).includes('PROXY_UNAVAILABLE')) {
          tea.notify.warning(err.message);
        }
      }
    })();
  }, [role]);

  if (role !== 'admin') return <Alert type="error">{t('error.FORBIDDEN')}</Alert>;

  return (
    <div>
      <Justify left={<H3>{t('systemConfig.title')}</H3>} />
      <Text theme="weak" parent="p" style={{ margin: '8px 0 20px' }}>
        {t('systemConfig.desc')}
      </Text>

      <Card>
        <Card.Body>
          <Text theme="label" parent="div" style={{ marginBottom: 4 }}>
            {t('systemConfig.readonly.upstream')}
          </Text>
          <Text parent="code" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {pinnedUpstream.url || '—'}
            {pinnedUpstream.model ? `（${pinnedUpstream.model}）` : ''}
          </Text>
        </Card.Body>
      </Card>
    </div>
  );
}
