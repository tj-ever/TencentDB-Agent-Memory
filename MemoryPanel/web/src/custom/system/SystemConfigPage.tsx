import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  H3,
  Input,
  Justify,
  Text,
} from 'tea-component';
import { useTranslation } from 'react-i18next';
import { proxyConfigApi, type ProxyAgentConfig } from '@/custom/api/proxy-config';
import { useCurrentRole } from '@/services/useCurrentRole';
import { tea } from '@/lib/tea-bridge';

interface EditableProxyAgent extends ProxyAgentConfig {
  rowId: string;
}

let proxyAgentRowSeq = 0;

function editableAgent(agent: ProxyAgentConfig): EditableProxyAgent {
  proxyAgentRowSeq += 1;
  return { ...agent, originalName: agent.name, rowId: `proxy-agent-${proxyAgentRowSeq}` };
}

/**
 * 开发者配置页 —— 开发者上游表（custom: tdai-proxy）
 *
 * 全局 Proxy 上游（URL/token/模型/识图）在顶栏⚙设置弹窗的「Proxy 上游」Tab，
 * 这里只维护按 agent URL 首段分流的开发者上游：每行一个名称 + 端点地址。
 * 模型 Key 由开发者自带透传；记忆身份走 x-tdai-user-key 请求头（复用面板
 * 「成员管理」下发的 sk-mem Key），会话绑定走 session-init 表单或 x-team-id 等头。
 */
export function SystemConfigPage() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const [agents, setAgents] = useState<EditableProxyAgent[]>([]);
  const [publicUrl, setPublicUrl] = useState('');
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  // 全局上游值由⚙设置弹窗维护；这里仅回显只读，保存开发者上游时原样透传，
  // 让后端 PUT 的 url 必填校验通过，不会误改全局配置。
  const [pinnedUpstream, setPinnedUpstream] = useState({ url: '', model: '', supportsImages: false });

  // 载入开发者上游当前值用于回显。
  useEffect(() => {
    if (role !== 'admin') return;
    (async () => {
      setProxyLoading(true);
      try {
        const cur = await proxyConfigApi.get();
        setAgents((cur.agents || []).map(editableAgent));
        setPublicUrl(cur.publicUrl || '');
        setPinnedUpstream({ url: cur.url, model: cur.model, supportsImages: cur.supportsImages });
      } catch (err) {
        if (err instanceof Error && !String(err.message).includes('PROXY_UNAVAILABLE')) {
          tea.notify.warning(err.message);
        }
      } finally {
        setProxyLoading(false);
      }
    })();
  }, [role]);

  async function saveAgents() {
    if (agents.some((a) => !a.name.trim() || !a.url.trim())) {
      tea.notify.warning(t('systemConfig.agents.invalid'));
      return;
    }
    setProxySaving(true);
    try {
      const cur = await proxyConfigApi.update({
        url: pinnedUpstream.url,
        model: pinnedUpstream.model,
        supportsImages: pinnedUpstream.supportsImages,
        agents: agents.map((a) => ({ name: a.name, originalName: a.originalName, url: a.url })),
      });
      setAgents((cur.agents || []).map(editableAgent));
      setPinnedUpstream({ url: cur.url, model: cur.model, supportsImages: cur.supportsImages });
      tea.notify.success(t('systemConfig.proxy.saved'));
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setProxySaving(false);
    }
  }

  function updateAgent(rowId: string, k: keyof ProxyAgentConfig, v: string) {
    setAgents((prev) => prev.map((a) => (a.rowId === rowId ? { ...a, [k]: v } : a)));
  }
  function addAgent() {
    setAgents((prev) => [...prev, editableAgent({ name: '', url: '' })]);
  }
  function removeAgent(rowId: string) {
    setAgents((prev) => prev.filter((a) => a.rowId !== rowId));
  }

  // 生成开发者接入模板：开发者用自己的模型 Key + 独立的记忆 Key（x-tdai-user-key），
  // 会话 ID 由 Claude CLI 自生成。
  function buildCcConfig(a: ProxyAgentConfig): string {
    const base = (publicUrl || `http://${window.location.hostname}:8096`).replace(/\/+$/, '');
    return JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: `${base}/${a.name}/default`,
        ANTHROPIC_AUTH_TOKEN: '<替换为你的模型提供方 Key>',
        ANTHROPIC_CUSTOM_HEADERS: 'x-tdai-user-key: <替换为你的记忆 Key（sk-mem-*）>',
      },
    }, null, 2);
  }

  async function copyText(text: string): Promise<void> {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('复制失败，请改用 HTTPS 或手动复制');
  }

  async function copyCcConfig(a: ProxyAgentConfig) {
    try {
      await copyText(buildCcConfig(a));
      tea.notify.success(`${a.name} CC 配置已复制`);
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (role !== 'admin') return <Alert type="error">{t('error.FORBIDDEN')}</Alert>;

  return (
    <div>
      <Justify left={<H3>{t('systemConfig.title')}</H3>} />
      <Text theme="weak" parent="p" style={{ margin: '8px 0 20px' }}>
        {t('systemConfig.desc')}
      </Text>

      <Card>
        <Card.Body>
          <div style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{t('systemConfig.agents.title')}</span>
            <Text theme="weak" parent="span" style={{ marginLeft: 8, fontSize: 12 }}>
              {t('systemConfig.agents.hint')}
            </Text>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {agents.map((a) => (
              <div key={a.rowId} style={{ border: '1px solid #e0e5eb', borderRadius: 8, padding: '12px 16px' }}>
                <div className="_memory-agent-row" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <label style={{ flex: '0 0 130px' }}>
                    <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{t('systemConfig.agents.name')}</span>
                    <Input placeholder="dev-xxx" value={a.name} onChange={(v) => updateAgent(a.rowId, 'name', v)} />
                  </label>
                  <label style={{ flex: '1 1 240px' }}>
                    <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{t('systemConfig.agents.url')}</span>
                    <Input placeholder="https://…/v1" value={a.url} onChange={(v) => updateAgent(a.rowId, 'url', v)} />
                  </label>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                    <Button onClick={() => void copyCcConfig(a)}>{t('systemConfig.agents.copyCc')}</Button>
                    <Button onClick={() => removeAgent(a.rowId)}>{t('systemConfig.agents.remove')}</Button>
                  </div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Button type="link" onClick={addAgent}>{t('systemConfig.agents.add')}</Button>
              <Text theme="weak" parent="span" style={{ fontSize: 12 }}>{t('systemConfig.agents.clientsHint')}</Text>
              <div style={{ flex: 1 }} />
              <Button type="primary" loading={proxySaving} disabled={proxyLoading} onClick={() => void saveAgents()}>
                {t('systemConfig.agents.save')}
              </Button>
            </div>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}
