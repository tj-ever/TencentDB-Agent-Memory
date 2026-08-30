import { describe, expect, it } from 'vitest';
import { createThinkFilter, extractStreamDelta, friendlyUpstreamError } from './claudeRunner.js';

describe('extractStreamDelta api_retry', () => {
  it('解析 429 重试事件', () => {
    const evt = {
      type: 'system', subtype: 'api_retry',
      attempt: 3, max_retries: 10, retry_delay_ms: 2000, error_status: 429, error: 'rate_limit',
    };
    expect(extractStreamDelta(evt)).toEqual({
      kind: 'retry', attempt: 3, maxRetries: 10, status: 429, delayMs: 2000,
    });
  });

  it('普通 system 事件不误判为 retry', () => {
    expect(extractStreamDelta({ type: 'system', subtype: 'init' })).toBeNull();
  });
});

describe('createThinkFilter（MiniMax 内联推理剥离）', () => {
  it('整体一段：剥掉 think，保留正文', () => {
    const f = createThinkFilter();
    expect(f.push('<mm:think>推理过程</mm:think>答案正文')).toBe('答案正文');
  });

  it('标签被增量切断也能正确拼接', () => {
    const f = createThinkFilter();
    const chunks = ['<mm:th', 'ink>推理', '中…</mm:thi', 'nk>正', '文内容'];
    expect(chunks.map((c) => f.push(c)).join('')).toBe('正文内容');
  });

  it('没有 think 的普通文本原样通过（含伪前缀）', () => {
    const f = createThinkFilter();
    expect(f.push('价格 < 100，')).toBe('价格 < 100，');
  });

  it('think 未闭合时全部扣住，闭合后放行', () => {
    const f = createThinkFilter();
    expect(f.push('<mm:think>还没想完')).toBe('');
    expect(f.push('……')).toBe('');
    expect(f.push('</mm:think>好了')).toBe('好了');
  });

  it('流以半个疑似标签结尾：flush 按字面放行；think 未闭合则丢弃', () => {
    const f = createThinkFilter();
    f.push('结论是 <mm');
    expect(f.flush()).toBe('<mm');
    const g = createThinkFilter();
    g.push('正文<mm:think>截断');
    expect(g.flush()).toBe('');
  });
});

describe('friendlyUpstreamError（429 配额耗尽转中文提示）', () => {
  it('识别带重置时间的 API Error 文本', () => {
    expect(friendlyUpstreamError('API Error: Request rejected (429) · You have exceeded the 5-hour usage quota. It will reset at 2026-08-28 13:56:28 +0800 CST. We recommend…'))
      .toBe('⏳ 上游模型额度暂时用尽（预计 2026-08-28 13:56:28 +0800 恢复），请稍后重新发送需求。');
  });

  it('无重置时间也能给出提示；普通文本不误判', () => {
    expect(friendlyUpstreamError('API Error: overloaded')).toBe('⏳ 上游模型额度暂时用尽，请稍后重新发送需求。');
    expect(friendlyUpstreamError('这是正常回复，虽然提到 API Error 但不在开头')).toBeNull();
  });
});
