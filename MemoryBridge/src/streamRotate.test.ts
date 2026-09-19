// 行安全缓冲：append 边界切进 ``` 围栏会触发飞书 cardkit 流式解析吞围栏 token
// （线上残卡：SQL 代码块缺开头 + plain_text 幽灵块）。缓冲必须保证：
// 1) 不从反引号串中间放行；2) 换行边界整行放行;3) 收尾/轮换不丢尾。
import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { interjectStream, runWithRotatingMarkdown } from './streamRotate.js';

function fakeChannel() {
  const appends: string[] = [];
  const channel = {
    stream(_to: string, { markdown }: { markdown: (c: unknown) => Promise<void> }) {
      const ctl = {
        append: async (t: string) => { appends.push(t); },
        setContent: async (t: string) => { appends.length = 0; appends.push(t); },
      };
      // 不 await：producer 挂起不返回即模拟流未关
      void markdown(ctl);
      return Promise.resolve();
    },
  } as unknown as LarkChannel;
  return { channel, appends };
}

describe('streamRotate 行安全缓冲', () => {
  it('围栏被增量劈开时，放行内容始终整行（围栏行完整）', async () => {
    const { channel, appends } = fakeChannel();
    await runWithRotatingMarkdown(channel, 'chat', undefined, async (ctl) => {
      // 模拟 claude delta 把 ```sql 劈成多段 + 无换行长文
      for (const c of ['``', '`sq', 'l\nSELECT 1;\n', '``', '`\n尾行']) await ctl.append(c);
    });
    const joined = appends.join('');
    expect(joined).toContain('```sql\nSELECT 1;\n');
    expect(joined).toContain('尾行');
    // 每个 SDK 放行片段的尾部不允许是 1~2 个反引号（半个围栏）
    for (const a of appends) {
      const m = /`{1,2}$/.exec(a);
      expect(m, `片段以半个围栏结尾: ${JSON.stringify(a)}`).toBeNull();
    }
  });

  it('无换行长文超过 300 字符兜底放行，但不在反引号串中间切', async () => {
    const { channel, appends } = fakeChannel();
    await runWithRotatingMarkdown(channel, 'chat', undefined, async (ctl) => {
      await ctl.append('x'.repeat(250) + '```sq');
    });
    const out = appends.join('');
    expect(out.startsWith('x'.repeat(250))).toBe(true);
    // 兜底放行时尾部扣住疑似半个围栏
    const m = /`{1,2}$/.exec(out);
    expect(m, `兜底放行以半个围栏结尾: ${JSON.stringify(out)}`).toBeNull();
  });

  it('work 正常结束后缓冲残行不丢尾', async () => {
    const { channel, appends } = fakeChannel();
    await runWithRotatingMarkdown(channel, 'chat', undefined, async (ctl) => {
      await ctl.append('最后一行没有换行');
    });
    expect(appends.join('')).toContain('最后一行没有换行');
  });

  it('错误尾注前的缓冲残行也被灌出', async () => {
    const { channel, appends } = fakeChannel();
    await runWithRotatingMarkdown(channel, 'chat', undefined, async (ctl) => {
      await ctl.append('半行内容');
      throw new Error('boom');
    }).catch(() => {});
    const joined = appends.join('');
    expect(joined).toContain('半行内容');
    expect(joined).toContain('处理失败');
  });

  it('生成中插话写入当前卡，结束后插话被忽略', async () => {
    const { channel, appends } = fakeChannel();
    await runWithRotatingMarkdown(channel, 'chat', undefined, async (ctl) => {
      await ctl.append('正文\n');
      await interjectStream('chat', '（已收到新消息，完成后处理）');
      await ctl.append('正文2\n');
    });
    expect(appends.join('')).toContain('（已收到新消息，完成后处理）');
    // 会话结束（卡片关闭）后，迟到的插话不得写进任何卡
    await interjectStream('chat', '结束后不应出现');
    expect(appends.join('')).not.toContain('结束后不应出现');
  });
});
