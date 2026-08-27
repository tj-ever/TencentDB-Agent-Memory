/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * Tab 结构：
 *   - 「权限管理」：控制资源管理模块的开关（Wiki / Code / Skill / Chat_Memory），
 *     防止未稳定使用的模块被注入内核运行。
 *   - 「Proxy 上游」（仅 admin 可见）：配置面向所有 LLM 消费方的全局上游
 *     （URL/Token/模型/识图），由 memory-hub 面板经 /api/v1/proxy-config 读写。
 *
 * 后续可在 TABS 数组里追加其他 Tab（如通知、偏好设置等）。
 *
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Form,
  Input,
  Switch,
  TabPanel,
  Tabs,
  Text,
  Tag,
  Modal,
} from 'tea-component';
import {
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import { userConfigApi, type AssetCapabilityKey } from '@/lib/teamApi';
import { proxyConfigApi } from '@/custom/api/proxy-config';
import { type TeamRole } from '@/services/useCurrentRole';
import { tea } from '@/lib/tea-bridge';

// ===== 资源模块 =====

interface ResourceModule {
  id: string;
  paramKey: AssetCapabilityKey;
  labelKey: string;
  descKey: string;
  icon: JSX.Element;
}

const RESOURCE_MODULES: ResourceModule[] = [
  {
    id: 'wiki',
    paramKey: 'llm_wiki.enabled',
    labelKey: 'settings.module.wiki',
    descKey: 'settings.module.wiki.desc',
    icon: <BooksIcon size={16} />,
  },
  {
    id: 'code',
    paramKey: 'code_graph.enabled',
    labelKey: 'settings.module.code',
    descKey: 'settings.module.code.desc',
    icon: <CodeIcon size={16} />,
  },
  {
    id: 'skill',
    paramKey: 'skill.enabled',
    labelKey: 'settings.module.skill',
    descKey: 'settings.module.skill.desc',
    icon: <ToolsIcon size={16} />,
  },
  {
    id: 'chat_memory',
    paramKey: 'chat_memory.enabled',
    labelKey: 'settings.module.chatMemory',
    descKey: 'settings.module.chatMemory.desc',
    icon: <ChatIcon size={16} />,
  },
];

type SettingsTab = 'permissions' | 'proxy';

export function SettingsDialog({
  onClose,
  userRole,
}: {
  onClose: () => void;
  userRole: TeamRole | null;
}) {
  const { t } = useTranslation();
  const isAdmin = userRole === 'admin';
  // 非 admin 看不到 Proxy 上游 Tab，默认停在权限；admin 默认也停在权限。
  const [activeTab, setActiveTab] = useState<SettingsTab>('permissions');

  // ===== 权限 Tab 状态 =====
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    wiki: true,
    code: true,
    skill: true,
    chat_memory: true,
  }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AssetCapabilityKey | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    userConfigApi.getAssetCapabilities()
      .then((cfg) => {
        if (cancelled) return;
        setEnabled({
          wiki: cfg['llm_wiki.enabled'],
          code: cfg['code_graph.enabled'],
          skill: cfg['skill.enabled'],
          chat_memory: cfg['chat_memory.enabled'],
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(mod: ResourceModule, next: boolean) {
    const previous = enabled[mod.id];
    setEnabled((prev) => ({ ...prev, [mod.id]: next }));
    setSavingKey(mod.paramKey);
    setError('');
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      tea.notify.success(t(next ? 'settings.notify.enabled' : 'settings.notify.disabled', { label: t(mod.labelKey) }));
    } catch (e) {
      setEnabled((prev) => ({ ...prev, [mod.id]: previous }));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setSavingKey(null);
    }
  }

  // ===== Proxy 上游 Tab 状态 =====
  const [proxyForm, setProxyForm] = useState({ url: '', apiKey: '', model: '', supportsImages: false });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setProxyLoading(true);
    proxyConfigApi.get()
      .then((cur) => {
        if (cancelled) return;
        setProxyForm({ url: cur.url, apiKey: '', model: cur.model, supportsImages: cur.supportsImages });
      })
      .catch((err) => {
        if (!cancelled && !(err instanceof Error && String(err.message).includes('PROXY_UNAVAILABLE'))) {
          tea.notify.warning(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => { if (!cancelled) setProxyLoading(false); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  async function saveProxy() {
    if (!proxyForm.url.trim()) {
      tea.notify.warning(t('systemConfig.proxy.urlRequired'));
      return;
    }
    setProxySaving(true);
    try {
      const cur = await proxyConfigApi.update({
        url: proxyForm.url.trim(),
        apiKey: proxyForm.apiKey.trim() || undefined,
        model: proxyForm.model.trim(),
        supportsImages: proxyForm.supportsImages,
      });
      setProxyForm({ url: cur.url, apiKey: '', model: cur.model, supportsImages: cur.supportsImages });
      tea.notify.success(t('systemConfig.proxy.saved'));
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setProxySaving(false);
    }
  }

  // 只有权限 Tab 时不需要 Tabs 容器，保持原有单区块布局。
  const tabs = isAdmin
    ? [
        { id: 'permissions' as const, label: t('settings.tab.permissions') },
        { id: 'proxy' as const, label: t('settings.tab.proxy') },
      ]
    : [{ id: 'permissions' as const, label: t('settings.tab.permissions') }];

  // 权限面板抽成变量，admin 与非 admin 两种容器共用同一份渲染，避免重复代码。
  const permissionsPanel = (
    <div>
      <div style={{ paddingTop: 4 }}>
        <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
          {t('settings.title')}
        </Text>
        <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
          {t('settings.desc')}
        </Text>
        {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
        {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {RESOURCE_MODULES.map((mod) => (
            <div
              key={mod.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                border: '1px solid var(--tea-color-border-primary-default)',
                borderRadius: 6,
                background: enabled[mod.id]
                  ? 'var(--tea-color-bg-brand-lighten-default)'
                  : 'var(--tea-color-bg-primary-default)',
                transition: 'background-color 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ color: 'var(--tea-color-text-secondary)', flexShrink: 0 }}>
                  {mod.icon}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 13, fontWeight: 500 }}>
                      {t(mod.labelKey)}
                    </Text>
                    {savingKey === mod.paramKey ? (
                      <Tag theme="warning" variant="soft" size="sm">{t('settings.tag.saving')}</Tag>
                    ) : enabled[mod.id] ? (
                      <Tag theme="success" variant="soft" size="sm">{t('settings.tag.enabled')}</Tag>
                    ) : (
                      <Tag theme="default" variant="soft" size="sm">{t('settings.tag.disabled')}</Tag>
                    )}
                  </div>
                  <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                    {t(mod.descKey)}
                  </Text>
                </div>
              </div>
              <Switch
                value={enabled[mod.id]}
                disabled={loading || savingKey === mod.paramKey}
                onChange={(v) => void handleToggle(mod, v)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <Modal visible caption={t('settings.caption')} size="m" onClose={onClose}>
      <Modal.Body>
        {isAdmin ? (
          <Tabs
            activeId={activeTab}
            onActive={(tab) => setActiveTab(tab.id as SettingsTab)}
            tabs={tabs}
          >
            <TabPanel id="permissions">{permissionsPanel}</TabPanel>
            <TabPanel id="proxy">
              {proxyLoading ? (
                <Alert type="info">{t('settings.loadingConfig')}</Alert>
              ) : (
                <div>
                  <Text theme="weak" parent="p" style={{ fontSize: 12, margin: '4px 0 12px' }}>
                    {t('systemConfig.proxy.hint')}
                  </Text>
                  <div className="_memory-proxy-form" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Form.Item label={t('systemConfig.proxy.url')} style={{ minWidth: 320, flex: '1 1 320px', marginBottom: 0 }}>
                      <Input value={proxyForm.url} placeholder="https://…/v1" onChange={(v) => setProxyForm((f) => ({ ...f, url: v }))} />
                    </Form.Item>
                    <Form.Item label={t('systemConfig.proxy.apiKey')} style={{ minWidth: 260, flex: '1 1 260px', marginBottom: 0 }}>
                      <Input type="password" placeholder={t('systemConfig.proxy.apiKeyPlaceholder')} value={proxyForm.apiKey}
                        onChange={(v) => setProxyForm((f) => ({ ...f, apiKey: v }))} />
                    </Form.Item>
                    <Form.Item label={t('systemConfig.proxy.model')} style={{ minWidth: 220, flex: '1 1 220px', marginBottom: 0 }}>
                      <Input value={proxyForm.model} placeholder="ark-code-latest" onChange={(v) => setProxyForm((f) => ({ ...f, model: v }))} />
                    </Form.Item>
                  </div>
                  <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Switch value={proxyForm.supportsImages} onChange={(v) => setProxyForm((f) => ({ ...f, supportsImages: v }))} />
                      <span>{t('systemConfig.proxy.supportsImages')}</span>
                    </label>
                    <Text theme="weak" parent="span" style={{ fontSize: 12 }}>{t('systemConfig.proxy.supportsImagesHint')}</Text>
                    <div style={{ flex: 1 }} />
                    <Button type="primary" loading={proxySaving} onClick={() => void saveProxy()}>
                      {t('systemConfig.proxy.save')}
                    </Button>
                  </div>
                </div>
              )}
            </TabPanel>
          </Tabs>
        ) : (
          permissionsPanel
        )}
      </Modal.Body>
    </Modal>
  );
}
