import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Input, Tag, Tabs, Text } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { useCurrentRole } from '@/services/useCurrentRole';
import { tea } from '@/lib/tea-bridge';
import { customCapabilitiesApi, type BridgeConfigData } from '@/custom/api/custom-capabilities';
import { getCapabilityRegistry, PROGRAM_DOC_ITEMS } from '@/custom/capabilities/registry';

/** 编辑项 = 注册表元数据 + 当前值（来自后端 GET 快照）。 */
interface ConfigItem {
  id: string;
  title: string;
  description: string;
  multiline?: boolean;
  value: string;
  /** proxy：是否已覆盖（text!==null）；bridge：字段已配置。 */
  configured: boolean;
}

function bridgeItemValue(b: BridgeConfigData, key: string): { value: string; configured: boolean } {
  const v = (b as unknown as Record<string, unknown>)[key];
  if (Array.isArray(v)) return { value: (v as string[]).join('\n'), configured: v.length > 0 };
  if (typeof v === 'string') return { value: v, configured: true };
  return { value: '', configured: false };
}

export function CapabilitiesPage() {
  const { t } = useTranslation();
  const role = useCurrentRole();

  const [activeTab, setActiveTab] = useState('talk');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // 当前值（来自后端）+ 编辑草稿（本地）。草稿不落 state 归并，保存即提交单条。
  const [proxyMap, setProxyMap] = useState<Record<string, { enabled: boolean; text: string | null }>>({});
  const [bridgeMap, setBridgeMap] = useState<BridgeConfigData>({});

  async function load() {
    setLoading(true);
    try {
      const state = await customCapabilitiesApi.get();
      const p: Record<string, { enabled: boolean; text: string | null }> = {};
      for (const item of state.proxy) p[item.id] = { enabled: item.enabled, text: item.text };
      setProxyMap(p);
      setBridgeMap(state.bridge ?? {});
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (role !== 'admin') return;
    void load();
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveProxy(id: string, value: string) {
    setSavingId(id);
    try {
      await customCapabilitiesApi.update('proxy', {
        capabilities: [{ id, enabled: value.trim().length > 0, text: value }],
      });
      await load();
      tea.notify.success(t('capabilities.saved'));
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  /** 恢复默认：proxy 发 enabled:false（route 删除覆盖），bridge 发 null（删除配置项）。 */
  async function resetItem(target: 'proxy' | 'bridge', id: string) {
    setSavingId(id);
    try {
      if (target === 'proxy') {
        await customCapabilitiesApi.update('proxy', { capabilities: [{ id, enabled: false }] });
      } else {
        await customCapabilitiesApi.update('bridge', { [id]: null });
      }
      await load();
      tea.notify.success(t('capabilities.restored'));
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  async function saveBridge(id: string, value: string) {
    const payload: Record<string, unknown> = {};
    if (id === 'reset_commands') {
      payload[id] = value.split('\n').map((s) => s.trim()).filter(Boolean);
    } else {
      payload[id] = value;
    }
    setSavingId(id);
    try {
      await customCapabilitiesApi.update('bridge', payload);
      await load();
      tea.notify.success(t('capabilities.saved'));
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  const proxyItems: ConfigItem[] = useMemo(
    () => getCapabilityRegistry()
      .filter((c) => c.kind === 'config' && c.configTarget === 'proxy')
      .map((c) => {
        const cur = proxyMap[c.id];
        return {
          id: c.id,
          title: c.title,
          description: c.description,
          multiline: true,
          value: cur?.text ?? '',
          configured: !!cur?.enabled && cur.text !== null,
        };
      }),
    [proxyMap],
  );

  const bridgeItems: ConfigItem[] = useMemo(
    () => getCapabilityRegistry()
      .filter((c) => c.kind === 'config' && c.configTarget === 'bridge')
      .map((c) => {
        const { value, configured } = bridgeItemValue(bridgeMap, c.id);
        const multiline = c.id === 'reset_commands' || /reply|text|template/.test(c.id);
        return { id: c.id, title: c.title, description: c.description, multiline, value, configured };
      }),
    [bridgeMap],
  );

  if (role !== 'admin') return <Alert type="error">{t('error.FORBIDDEN')}</Alert>;

  const programDocs = PROGRAM_DOC_ITEMS.filter((c) => c.doc && c.doc.length > 0);

  return (
    <div>
      <Text theme="primary" parent="h2" style={{ fontSize: 20, fontWeight: 600 }}>
        {t('capabilities.title')}
      </Text>
      <Text theme="weak" parent="p" style={{ margin: '8px 0 20px' }}>
        {t('capabilities.desc')}
      </Text>

      <Tabs
        activeId={activeTab}
        onActive={(tab) => setActiveTab(tab.id as string)}
        disableTabScrolling
        tabs={[
          { id: 'talk', label: t('capabilities.tab.talk') },
          { id: 'bridge', label: t('capabilities.tab.bridge') },
          { id: 'docs', label: t('capabilities.tab.docs') },
        ]}
      />

      {activeTab === 'talk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {proxyItems.map((item) => (
            <CapabilityCard
              key={item.id}
              item={item}
              saving={savingId === item.id}
              disabled={loading}
              onSave={(v) => void saveProxy(item.id, v)}
              onReset={() => void resetItem('proxy', item.id)}
            />
          ))}
        </div>
      )}

      {activeTab === 'bridge' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {bridgeItems.map((item) => (
            <CapabilityCard
              key={item.id}
              item={item}
              saving={savingId === item.id}
              disabled={loading}
              onSave={(v) => void saveBridge(item.id, v)}
              onReset={() => void resetItem('bridge', item.id)}
            />
          ))}
        </div>
      )}

      {activeTab === 'docs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {programDocs.map((c) => (
            <Card key={c.id}>
              <Card.Body>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
                <Text theme="weak" parent="p">{c.description}</Text>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7, marginTop: 8, color: '#4b5563' }}>
                  {c.doc}
                </pre>
              </Card.Body>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

interface CapabilityCardProps {
  item: ConfigItem;
  saving: boolean;
  disabled: boolean;
  onSave: (value: string) => void;
  onReset: () => void;
}

/** 单条可配项的编辑卡片：标题 + 状态 Tag + 只读当前值提示 + textarea + 保存/恢复默认。 */
function CapabilityCard({ item, saving, disabled, onSave, onReset }: CapabilityCardProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(item.value);

  // 后端快照刷新后同步草稿；用户编辑中不覆盖。
  useEffect(() => {
    if (!saving) setDraft(item.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.value]);

  const isResetCommands = item.id === 'reset_commands';
  return (
    <Card>
      <Card.Body>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{item.title}</span>
          <Text theme="weak" parent="span" style={{ fontSize: 12, color: '#8a919b' }}>{item.id}</Text>
          {item.configured ? (
            <Tag theme="success" variant="soft">{t('capabilities.configured')}</Tag>
          ) : (
            <Tag theme="default" variant="soft">{t('capabilities.default')}</Tag>
          )}
        </div>
        <Text theme="weak" parent="p" style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>
          {item.description}
        </Text>
        <Input.TextArea
          size="full"
          value={draft}
          onChange={setDraft}
          rows={isResetCommands ? 3 : item.multiline ? 8 : 2}
          placeholder={item.multiline ? t('capabilities.textareaPlaceholder') : undefined}
          disabled={saving || disabled}
          style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 13 }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button type="primary" loading={saving} disabled={disabled} onClick={() => onSave(draft)}>
            {t('capabilities.save')}
          </Button>
          <Button loading={saving && item.configured} disabled={disabled || !item.configured} onClick={onReset}>
            {t('capabilities.reset')}
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
}