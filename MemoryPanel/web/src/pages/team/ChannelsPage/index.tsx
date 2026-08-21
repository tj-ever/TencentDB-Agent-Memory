import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  H3,
  Input,
  Justify,
  Modal,
  Select,
  Switch,
  Table,
  Tag,
  Text,
  Tooltip,
} from 'tea-component';
import { useTranslation } from 'react-i18next';
import { HelpCircleIcon } from 'tea-icons-react';
import { channelsApi, type ChannelBot, type ChannelDraft } from '@/lib/api/channels';
import { tasksApi } from '@/lib/api/tasks';
import { tea } from '@/lib/tea-bridge';
import { useAgents, useTeams } from '@/stores/backend';

const { autotip } = Table.addons;

/** 表单标签 + 问号图标（hover 展示说明）。 */
function HelpLabel({ text, help }: { text: string; help: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <span>{text}</span>
      <Tooltip title={help}>
        <span
          className="channel-help-q"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            marginLeft: 4,
            color: '#9aa0a8',
            cursor: 'help',
          }}
        >
          <HelpCircleIcon size={15} />
        </span>
      </Tooltip>
    </span>
  );
}

const EMPTY: ChannelDraft = {
  name: '',
  work_dir: '',
  memory: { proxy_base_url: '', space_id: 'default', user_key: '' },
  binding: { team_id: '', agent_id: '', task_id: '' },
  feishu: {
    app_id: '',
    app_secret: '',
    stream_initial_text: '思考中…',
    policy: { requireMention: true, dmMode: 'open' },
  },
  llm: { model: 'grok-4.6' },
  session_mode: 'none',
  system_prompt: '',
};

export function ChannelsPage() {
  const { t } = useTranslation();
  const { activeTeam, loading: teamLoading } = useTeams();
  const teamId = activeTeam?.team_id ?? null;
  const { agents } = useAgents(teamId);
  const [tasks, setTasks] = useState<Array<{ task_id: string; title: string }>>([]);
  const [bots, setBots] = useState<ChannelBot[]>([]);
  const [loading, setLoading] = useState(false);
  const [bridgeDown, setBridgeDown] = useState(false);
  const [editing, setEditing] = useState<ChannelBot | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ChannelDraft>(EMPTY);
  const [saving, setSaving] = useState(false);
  /** 正在执行的行内操作（start/stop/delete），用于二次确认后的 loading 与按钮禁用 */
  const [pending, setPending] = useState<{ id: string; op: string } | null>(null);

  useEffect(() => {
    if (!teamId) {
      setTasks([]);
      return;
    }
    void tasksApi.list(teamId).then((list) => {
      setTasks(list.map((x) => ({ task_id: x.task_id, title: x.title })));
    }).catch(() => setTasks([]));
  }, [teamId]);

  const refresh = useCallback(async () => {
    if (!teamId) {
      setBots([]);
      return;
    }
    setLoading(true);
    try {
      const list = await channelsApi.list(teamId);
      setBots(list);
      setBridgeDown(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('BRIDGE_UNAVAILABLE') || msg.includes('Failed to fetch')) {
        setBridgeDown(true);
        setBots([]);
      } else {
        tea.notify.error(err);
      }
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => { void refresh(); }, [refresh]);

  function openCreate() {
    setEditing(null);
    setForm({
      ...EMPTY,
      binding: { ...EMPTY.binding, team_id: teamId || '' },
      work_dir: teamId ? `workspaces/${teamId}` : '',
    });
    setCreating(true);
  }

  function openEdit(bot: ChannelBot) {
    setEditing(bot);
    setForm({
      name: bot.name,
      work_dir: bot.work_dir,
      memory: { ...bot.memory, user_key: '' },
      binding: { ...bot.binding },
      feishu: { ...bot.feishu, app_secret: '' },
      llm: { ...bot.llm },
      session_mode: bot.session_mode,
      system_prompt: bot.system_prompt,
    });
    setCreating(true);
  }

  async function save() {
    if (!teamId) return;
    setSaving(true);
    try {
      const body: ChannelDraft = {
        ...form,
        binding: { ...form.binding, team_id: teamId },
      };
      if (editing) await channelsApi.update(editing.id, body);
      else await channelsApi.create(body);
      setCreating(false);
      await refresh();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(bot: ChannelBot) {
    const isRunning = bot.status === 'running';
    const op = isRunning ? 'stop' : 'start';
    const ok = await tea.confirm({
      message: isRunning
        ? t('channels.confirmStop', { name: bot.name })
        : t('channels.confirmStart', { name: bot.name }),
    });
    if (!ok) return;
    setPending({ id: bot.id, op });
    try {
      if (isRunning) await channelsApi.stop(bot.id);
      else await channelsApi.start(bot.id);
      await refresh();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setPending(null);
    }
  }

  async function remove(bot: ChannelBot) {
    const ok = await tea.confirm({
      message: t('channels.deleteConfirm', { name: bot.name }),
      description: t('channels.deleteHint'),
    });
    if (!ok) return;
    setPending({ id: bot.id, op: 'delete' });
    try {
      await channelsApi.remove(bot.id);
      await refresh();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setPending(null);
    }
  }

  const agentOptions = useMemo(
    () => agents.map((a) => ({ value: a.agent_id, text: `${a.name} (${a.agent_id})` })),
    [agents],
  );
  const taskOptions = useMemo(
    () => tasks.map((x) => ({ value: x.task_id, text: `${x.title} (${x.task_id})` })),
    [tasks],
  );

  if (teamLoading) return null;
  if (!teamId) {
    return <Alert type="info">{t('channels.needTeam')}</Alert>;
  }

  return (
    <Card>
      <Card.Body>
        <Justify
          left={<H3>{t('channels.title')}</H3>}
          right={
            <Button type="primary" onClick={openCreate} disabled={bridgeDown}>
              {t('channels.create')}
            </Button>
          }
        />
        <Text theme="weak" parent="p" style={{ margin: '8px 0 16px' }}>{t('channels.desc')}</Text>
        {bridgeDown && (
          <Alert type="warning" style={{ marginBottom: 16 }}>
            {t('channels.bridgeDown')}
          </Alert>
        )}
        <Table
          records={bots}
          recordKey="id"
          addons={[autotip({ isLoading: loading, emptyText: t('channels.empty') })]}
          columns={[
            { key: 'name', header: t('channels.col.name') },
            {
              key: 'status',
              header: t('channels.col.status'),
              render: (b) => (
                <Tag theme={b.status === 'running' ? 'success' : b.status === 'error' ? 'error' : 'default'}>
                  {t(`channels.status.${b.status}`)}
                </Tag>
              ),
            },
            {
              key: 'binding',
              header: t('channels.col.binding'),
              render: (b) => {
                const agent = agents.find((a) => a.agent_id === b.binding.agent_id);
                const task = tasks.find((x) => x.task_id === b.binding.task_id);
                return (
                  <div>
                    <div>{agent ? agent.name : b.binding.agent_id}</div>
                    <Text theme="weak" parent="div" style={{ fontSize: 12 }}>
                      {task ? task.title : b.binding.task_id}
                    </Text>
                  </div>
                );
              },
            },
            { key: 'session_mode', header: t('channels.col.session'), render: (b) => t(`channels.session.${b.session_mode}`) },
            {
              key: 'ops',
              header: t('channels.col.ops'),
              render: (b) => {
                const busy = pending?.id === b.id;
                const startStopBusy = busy && pending?.op !== 'delete';
                const deleteBusy = busy && pending?.op === 'delete';
                return (
                  <>
                    <Button
                      type="link"
                      loading={startStopBusy}
                      disabled={busy}
                      onClick={() => toggle(b)}
                    >
                      {b.status === 'running' ? t('channels.stop') : t('channels.start')}
                    </Button>
                    <Button type="link" disabled={busy} onClick={() => openEdit(b)}>
                      {t('channels.edit')}
                    </Button>
                    <Button type="link" loading={deleteBusy} disabled={busy} onClick={() => remove(b)}>
                      {t('channels.delete')}
                    </Button>
                    {busy && (
                      <Text theme="weak" parent="span" style={{ marginLeft: 6 }}>
                        {t('channels.processing')}
                      </Text>
                    )}
                  </>
                );
              },
            },
          ]}
        />
      </Card.Body>

      <Modal
        visible={creating}
        caption={editing ? t('channels.editTitle') : t('channels.createTitle')}
        size="l"
        onClose={() => setCreating(false)}
      >
        <Modal.Body>
          <Form>
            <Form.Item label={<HelpLabel text={t('channels.field.name')} help={t('channels.help.name')} />}>
              <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.workDir')} help={t('channels.help.workDir')} />}>
              <Input value={form.work_dir} onChange={(v) => setForm({ ...form, work_dir: v })} />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.agent')} help={t('channels.help.agent')} />}>
              <Select
                size="full"
                options={agentOptions}
                value={form.binding.agent_id}
                onChange={(v) => setForm({ ...form, binding: { ...form.binding, agent_id: String(v) } })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.task')} help={t('channels.help.task')} />}>
              <Select
                size="full"
                options={taskOptions}
                value={form.binding.task_id}
                onChange={(v) => setForm({ ...form, binding: { ...form.binding, task_id: String(v) } })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.session')} help={t('channels.help.session')} />}>
              <Select
                size="m"
                options={[
                  { value: 'none', text: t('channels.session.none') },
                  { value: 'user', text: t('channels.session.user') },
                  { value: 'chat', text: t('channels.session.chat') },
                ]}
                value={form.session_mode}
                onChange={(v) => setForm({ ...form, session_mode: v as ChannelDraft['session_mode'] })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.model')} help={t('channels.help.model')} />}>
              <Input value={form.llm.model} onChange={(v) => setForm({ ...form, llm: { model: v } })} />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.proxy')} help={t('channels.help.proxy')} />}>
              <Input
                placeholder="http://tdai-proxy:8096"
                value={form.memory.proxy_base_url}
                onChange={(v) => setForm({ ...form, memory: { ...form.memory, proxy_base_url: v } })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.userKey')} help={t('channels.help.userKey')} />}>
              <Input
                type="password"
                placeholder={editing ? t('channels.keepSecret') : 'sk-mem-…'}
                value={form.memory.user_key}
                onChange={(v) => setForm({ ...form, memory: { ...form.memory, user_key: v } })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.appId')} help={t('channels.help.appId')} />}>
              <Input
                value={form.feishu.app_id}
                onChange={(v) => setForm({ ...form, feishu: { ...form.feishu, app_id: v } })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.appSecret')} help={t('channels.help.appSecret')} />}>
              <Input
                type="password"
                placeholder={editing ? t('channels.keepSecret') : ''}
                value={form.feishu.app_secret}
                onChange={(v) => setForm({ ...form, feishu: { ...form.feishu, app_secret: v } })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.requireMention')} help={t('channels.help.requireMention')} />}>
              <Switch
                value={form.feishu.policy.requireMention}
                onChange={(v) => setForm({
                  ...form,
                  feishu: { ...form.feishu, policy: { ...form.feishu.policy, requireMention: v } },
                })}
              />
            </Form.Item>
            <Form.Item label={<HelpLabel text={t('channels.field.systemPrompt')} help={t('channels.help.systemPrompt')} />}>
              <Input.TextArea
                size="full"
                rows={6}
                value={form.system_prompt}
                onChange={(v) => setForm({ ...form, system_prompt: v })}
                placeholder={t('channels.field.systemPromptHint')}
              />
            </Form.Item>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button type="primary" loading={saving} onClick={() => void save()}>{t('channels.save')}</Button>
          <Button onClick={() => setCreating(false)}>{t('channels.cancel')}</Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}
