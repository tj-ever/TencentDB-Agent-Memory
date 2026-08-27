import { describe, expect, it } from 'vitest';
import { extractStreamDelta } from './claudeRunner.js';

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
