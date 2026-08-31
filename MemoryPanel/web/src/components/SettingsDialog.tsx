/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * Tab 结构：
 *   - 「权限管理」：控制资源管理模块的开关（Wiki / Code / Skill / Chat_Memory），
 *     防止未稳定使用的模块被注入内核运行。
 *   - 「Proxy 上游」（仅 admin 可见）：多上游 profile 表格，启用开关单选控制
 *     当前生效上游（enabled 那条派生为全局 upstream），由 memory-hub 面板经
 *     /api/v1/proxy-config 读写。
 *
 * 后续可在 TABS 数组里追加其他 Tab（如通知、偏好设置等）。
 *
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Input,
  Switch,
  Table,
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
  AddIcon,
  DeleteIcon,
} from 'tea-icons-react';
import { userConfigApi, type AssetCapabilityKey } from '@/lib/teamApi';
import { proxyConfigApi, type ProxyProfile } from '@/custom/api/proxy-config';
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

  // ===== Proxy 上游 Tab 状态（多 profile 表格） =====
  interface EditableProfile extends ProxyProfile {
    /** 前端行 key；id 仅在行来自服务端时有值。 */
    rowKey: string;
  }

  const [profiles, setProfiles] = useState<EditableProfile[]>([]);
  const [rowSeq, setRowSeq] = useState(0);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);

  function toEditable(list: ProxyProfile[]): EditableProfile[] {
    return list.map((p, i) => ({ ...p, rowKey: p.id || `row-${i}` }));
  }

  function fromSnapshot(cur: Awaited<ReturnType<typeof proxyConfigApi.get>>): EditableProfile[] {
    // 首次迁移：服务端还没有 profiles，用当前生效 upstream 播种一行（掩码 key 保留在服务端）。
    if (!cur.profiles.length) {
      return [{
        id: 'up-1',
        name: '',
        url: cur.url,
        apiKey: cur.apiKey,
        userAgent: cur.userAgent,
        model: cur.model,
        supportsImages: cur.supportsImages,
        enabled: true,
        rowKey: 'up-1',
      }];
    }
    return toEditable(cur.profiles);
  }

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setProxyLoading(true);
    proxyConfigApi.get()
      .then((cur) => {
        if (cancelled) return;
        setProfiles(fromSnapshot(cur));
      })
      .catch((err) => {
        if (!cancelled && !(err instanceof Error && String(err.message).includes('PROXY_UNAVAILABLE'))) {
          tea.notify.warning(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => { if (!cancelled) setProxyLoading(false); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  function patchRow(rowKey: string, patch: Partial<EditableProfile>) {
    setProfiles((rows) => rows.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)));
  }

  /** 单选语义：开启某行 = 其余全部关闭；关闭唯一启用行不生效（删行即可）。 */
  function toggleEnabled(rowKey: string, v: boolean) {
    setProfiles((rows) => (v
      ? rows.map((r) => ({ ...r, enabled: r.rowKey === rowKey }))
      : rows));
  }

  function addRow() {
    const rowKey = `row-new-${rowSeq}`;
    setRowSeq((n) => n + 1);
    setProfiles((rows) => [...rows, {
      id: '',
      name: '',
      url: '',
      apiKey: '',
      userAgent: '',
      model: '',
      supportsImages: false,
      enabled: false,
      rowKey,
    }]);
  }

  function removeRow(rowKey: string) {
    setProfiles((rows) => {
      const next = rows.filter((r) => r.rowKey !== rowKey);
      // 删掉的是启用行时自动启用剩余第一行，避免 0 条 enabled。
      if (rows.find((r) => r.rowKey === rowKey)?.enabled && next.length) {
        return next.map((r, i) => ({ ...r, enabled: i === 0 }));
      }
      return next;
    });
  }

  async function saveProxy() {
    const rows = profiles.map(({ rowKey: _rowKey, ...p }) => p);
    if (rows.some((p) => !p.url.trim())) {
      tea.notify.warning(t('systemConfig.proxy.urlRequired'));
      return;
    }
    if (rows.filter((p) => p.enabled).length !== 1) {
      tea.notify.warning(t('systemConfig.proxy.exactlyOne'));
      return;
    }
    setProxySaving(true);
    try {
      const cur = await proxyConfigApi.update({ url: rows.find((p) => p.enabled)!.url.trim(), profiles: rows });
      setProfiles(toEditable(cur.profiles));
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
    <Modal visible caption={t('settings.caption')} size={isAdmin ? 'xl' : 'm'} onClose={onClose}>
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
                  <Table
                    verticalTop
                    records={profiles}
                    recordKey="rowKey"
                    columns={[
                      {
                        key: 'enabled',
                        header: t('systemConfig.proxy.profile.enabled'),
                        width: 70,
                        render: (row) => (
                          <Switch
                            value={row.enabled}
                            onChange={(v) => toggleEnabled(row.rowKey, v)}
                          />
                        ),
                      },
                      {
                        key: 'name',
                        header: t('systemConfig.proxy.profile.name'),
                        width: 110,
                        render: (row) => (
                          <Input
                            size="s"
                            value={row.name}
                            placeholder={t('systemConfig.proxy.profile.namePlaceholder')}
                            onChange={(v) => patchRow(row.rowKey, { name: v })}
                          />
                        ),
                      },
                      {
                        key: 'url',
                        header: t('systemConfig.proxy.url'),
                        render: (row) => (
                          <Input
                            size="s"
                            value={row.url}
                            placeholder="https://…/v1"
                            onChange={(v) => patchRow(row.rowKey, { url: v })}
                          />
                        ),
                      },
                      {
                        key: 'apiKey',
                        header: t('systemConfig.proxy.apiKey'),
                        width: 150,
                        render: (row) => (
                          <Input
                            size="s"
                            value={row.apiKey}
                            placeholder={t('systemConfig.proxy.apiKeyPlaceholder')}
                            onChange={(v) => patchRow(row.rowKey, { apiKey: v })}
                          />
                        ),
                      },
                      {
                        key: 'model',
                        header: t('systemConfig.proxy.model'),
                        width: 130,
                        render: (row) => (
                          <Input
                            size="s"
                            value={row.model}
                            placeholder="ark-code-latest"
                            onChange={(v) => patchRow(row.rowKey, { model: v })}
                          />
                        ),
                      },
                      {
                        key: 'userAgent',
                        header: t('systemConfig.proxy.profile.userAgent'),
                        width: 150,
                        render: (row) => (
                          <Input
                            size="s"
                            value={row.userAgent}
                            placeholder="claude-cli/1.0.128 (external, cli)"
                            onChange={(v) => patchRow(row.rowKey, { userAgent: v })}
                          />
                        ),
                      },
                      {
                        key: 'supportsImages',
                        header: t('systemConfig.proxy.supportsImages'),
                        width: 70,
                        render: (row) => (
                          <Switch
                            value={row.supportsImages}
                            onChange={(v) => patchRow(row.rowKey, { supportsImages: v })}
                          />
                        ),
                      },
                      {
                        key: 'op',
                        header: t('systemConfig.proxy.profile.op'),
                        width: 60,
                        render: (row) => (
                          <Button
                            type="icon"
                            title={t('systemConfig.proxy.profile.delete')}
                            onClick={() => removeRow(row.rowKey)}
                          >
                            <DeleteIcon size={14} />
                          </Button>
                        ),
                      },
                    ]}
                  />
                  <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <Button onClick={addRow}>
                      <AddIcon size={14} />
                      {t('systemConfig.proxy.profile.add')}
                    </Button>
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
