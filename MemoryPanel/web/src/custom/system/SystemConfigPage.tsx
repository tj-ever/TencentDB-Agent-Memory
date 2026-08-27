import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  H3,
  Input,
  Justify,
  Select,
  Tag,
  Text,
} from 'tea-component';
import { useTranslation } from 'react-i18next';
import { proxyConfigApi, type ProxyAgentConfig } from '@/custom/api/proxy-config';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAgents, useTasks, useTeams } from '@/stores/backend';
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
 * 开发者配置页 —— 按团队管理开发者上游（custom: tdai-proxy）
 *
 * 全局 Proxy 上游（URL/token/模型/识图）已移入顶栏⚙设置弹窗的「Proxy 上游」Tab，
 * 这里只保留面向单个开发者的按 agent 分流上游表，并按左上角当前团队过滤展示。
 * 保存时全量回传（每条携带自身 team_id），不会改动其他团队的开发者上游。
 * 记忆绑定由 memory-hub 面板经 /api/v1/proxy-config 读写。
 */
export function SystemConfigPage() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const { activeTeam } = useTeams();
  const [agents, setAgents] = useState<EditableProxyAgent[]>([]);
  const [publicUrl, setPublicUrl] = useState('');
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  // 全局上游值由⚙设置弹窗维护；这里仅回显只读，保存开发者上游时原样透传，
  // 让后端 PUT 的 url 必填校验通过，不会误改全局配置。
  const [pinnedUpstream, setPinnedUpstream] = useState({ url: '', model: '', supportsImages: false });

  // 记忆绑定固定在「当前激活团队」上，无需逐行选择 team；Agent/Task 下拉按 activeTeam 拉取。
  const teamId = activeTeam?.team_id ?? null;
  const { agents: bindAgents } = useAgents(teamId);
  const { tasks: bindTasks } = useTasks(teamId);

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
    // 仅校验当前团队展示的行；其他团队的行原样回传，不在此处校验。
    const teamRows = teamId ? agents.filter((a) => a.binding?.team_id === teamId) : agents;
    if (!teamId || teamRows.some((a) => !a.name.trim() || !a.url.trim() || !a.binding?.agent_id || !a.binding?.task_id)) {
      tea.notify.warning(t('systemConfig.agents.invalid'));
      return;
    }
    setProxySaving(true);
    try {
      const cur = await proxyConfigApi.update({
        url: pinnedUpstream.url,
        model: pinnedUpstream.model,
        supportsImages: pinnedUpstream.supportsImages,
        // 全量回传：每条携带自身 team_id，其他团队的开发者上游不会被误删。
        agents: agents.map((a) => ({
          name: a.name,
          originalName: a.originalName,
          url: a.url,
          model: a.model,
          binding: a.binding?.agent_id
            ? { team_id: a.binding.team_id ?? teamId, agent_id: a.binding.agent_id, ...(a.binding.task_id ? { task_id: a.binding.task_id } : {}) }
            : undefined,
          // 回传已开通的记忆账号（GET 回显为掩码）：后端据此判断不再重复开通。
          memory: a.memory,
        })),
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
  // 更新某行的记忆绑定 Agent；团队固定为当前激活团队。切换 Agent 时清空 task，
  // 避免残留上一个 Agent 的 task_id（task 选项依赖团队而非 Agent，但语义上
  // 切换 Agent 应让用户重新确认 task）。
  function updateBinding(rowId: string, agent_id: string) {
    setAgents((prev) => prev.map((a) => (a.rowId === rowId ? { ...a, binding: { team_id: teamId ?? '', agent_id, task_id: a.binding?.agent_id === agent_id ? a.binding?.task_id : '' } } : a)));
  }
  function updateBindingTask(rowId: string, task_id: string) {
    setAgents((prev) => prev.map((a) => (a.rowId === rowId ? { ...a, binding: { team_id: a.binding?.team_id ?? teamId ?? '', agent_id: a.binding?.agent_id ?? '', task_id } } : a)));
  }
  function addAgent() {
    setAgents((prev) => [...prev, editableAgent({ name: '', url: '', model: '', binding: { team_id: teamId ?? '', agent_id: '', task_id: '' } })]);
  }
  function removeAgent(rowId: string) {
    setAgents((prev) => prev.filter((a) => a.rowId !== rowId));
  }

  // 生成开发者接入模板：开发者只需自己的模型 Key + 路径，记忆身份由服务端
  // 该 agent 的固定记忆账号自动承担（无需 x-tdai-user-key），会话 ID 由 Claude CLI 自生成。
  function buildCcConfig(a: ProxyAgentConfig): string {
    const base = (publicUrl || `http://${window.location.hostname}:8096`).replace(/\/+$/, '');
    return JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: `${base}/${a.name}/default`,
        ANTHROPIC_AUTH_TOKEN: '<替换为你的模型提供方 Key>',
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

  // 仅展示绑定到当前团队的开发者上游；其他团队的行仍保留在 state 中，
  // 保存时全量回传（每条自带 team_id），不会被误删。
  const displayAgents = teamId
    ? agents.filter((a) => (a.binding?.team_id || '') === teamId)
    : [];

  return (
    <div>
      <Justify
        left={<H3>{t('systemConfig.title')}</H3>}
        right={
          activeTeam ? (
            <Tag theme="primary" variant="soft">{t('systemConfig.currentTeam')}: {activeTeam.name}</Tag>
          ) : null
        }
      />
      <Text theme="weak" parent="p" style={{ margin: '8px 0 20px' }}>
        {t('systemConfig.desc')}
      </Text>

      {!teamId ? (
        <Alert type="warning">{t('systemConfig.agents.noTeam')}</Alert>
      ) : (
        <>
          {/* 全局 Proxy 上游（URL/Token/模型/识图）已移入顶栏⚙设置弹窗的「Proxy 上游」Tab */}

          {/* 开发者上游（按 agent URL 段分流，仅当前团队） */}
          <Card>
            <Card.Body>
              <div style={{ marginBottom: 16 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{t('systemConfig.agents.title')}</span>
                <Text theme="weak" parent="span" style={{ marginLeft: 8, fontSize: 12 }}>
                  {t('systemConfig.agents.hint')}
                </Text>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {displayAgents.map((a) => (
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
                      <label style={{ flex: '0 0 150px' }}>
                        <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{t('systemConfig.agents.model')}</span>
                        <Input placeholder={t('systemConfig.agents.modelPlaceholder')} value={a.model} onChange={(v) => updateAgent(a.rowId, 'model', v)} />
                      </label>
                      {/* 记忆绑定：该上游命中时以当前团队的 bound agent + task 注入；记忆账号自动生成 */}
                      <label style={{ flex: '0 0 150px' }}>
                        <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{t('systemConfig.agents.bindAgent')}</span>
                        <Select size="full" value={a.binding?.agent_id ?? ''} placeholder={t('systemConfig.agents.selectAgent')}
                          onChange={(v) => updateBinding(a.rowId, String(v))}
                          options={bindAgents.map((ag) => ({ value: ag.agent_id, text: ag.name }))}
                        />
                      </label>
                      <label style={{ flex: '0 0 150px' }}>
                        <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{t('systemConfig.agents.bindTask')}</span>
                        <Select size="full" value={a.binding?.task_id ?? ''} placeholder={t('systemConfig.agents.selectTask')}
                          onChange={(v) => updateBindingTask(a.rowId, String(v))}
                          options={bindTasks.map((tk) => ({ value: tk.task_id, text: tk.title }))}
                        />
                      </label>
                      <label style={{ flex: '0 0 200px' }}>
                        <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{t('systemConfig.agents.memAccount')}</span>
                        <span style={{ display: 'inline-block', fontSize: 12, lineHeight: '30px', color: a.memory?.key ? '#6b7280' : '#9aa0a8' }}>
                          {t(a.memory?.key ? 'systemConfig.agents.memAccountReady' : 'systemConfig.agents.memAccountAuto')}
                        </span>
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
        </>
      )}
    </div>
  );
}
