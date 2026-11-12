import { describe, expect, it } from 'vitest';

import { mapGenerationFailure } from './generation-errors';

describe('mapGenerationFailure', () => {
  it('maps network failures to a retryable message with auto-retry note', () => {
    const failure = mapGenerationFailure({
      code: 'PROVIDER_NETWORK',
      message: '无法连接模型服务。',
    });

    expect(failure).toMatchObject({
      title: '网络连接失败',
      retryable: true,
      autoRetried: true,
    });
    expect(failure.hint).toContain('自动重试一次');
  });

  it('maps auth failures to a non-retryable settings hint', () => {
    const failure = mapGenerationFailure({ code: 'PROVIDER_AUTH' });

    expect(failure).toMatchObject({
      title: '密钥无效或无权限',
      retryable: false,
      action: 'settings',
    });
    expect(failure.hint).toContain('API Key');
  });

  it('maps rate limits and server errors as auto-retried', () => {
    expect(mapGenerationFailure({ code: 'PROVIDER_RATE_LIMIT' })).toMatchObject({
      title: '请求过于频繁',
      retryable: true,
      autoRetried: true,
    });
    expect(mapGenerationFailure({ code: 'PROVIDER_SERVER' })).toMatchObject({
      title: '模型服务暂时不可用',
      retryable: true,
      autoRetried: true,
    });
  });

  it('does not mark timeouts or truncated output as auto-retried', () => {
    expect(mapGenerationFailure({ code: 'PROVIDER_TIMEOUT' })).toMatchObject({
      title: '生成超时',
      retryable: true,
      autoRetried: false,
    });
    expect(mapGenerationFailure({ code: 'OUTPUT_TRUNCATED' })).toMatchObject({
      title: '输出被截断',
      retryable: true,
      autoRetried: false,
    });
  });

  it('shows the server reason when the model returns no content', () => {
    expect(
      mapGenerationFailure({
        code: 'OUTPUT_TRUNCATED',
        message: '模型没有返回任何内容，输出可能已被截断。',
      }).description,
    ).toBe('模型没有返回任何内容，输出可能已被截断。');
  });

  it('maps invalid model output and integrity failures', () => {
    expect(mapGenerationFailure({ code: 'OUTPUT_INVALID' }).title).toBe(
      '模型输出格式异常',
    );
    expect(mapGenerationFailure({ code: 'INTEGRITY' }).title).toBe('计划结构不完整');
  });

  it('shows the server message for invalid input', () => {
    const failure = mapGenerationFailure({
      code: 'INVALID_INPUT',
      message: '粘贴内容不能为空。',
    });

    expect(failure.description).toBe('粘贴内容不能为空。');
    expect(failure.retryable).toBe(false);
  });

  it('formats issue details as readable field paths', () => {
    const failure = mapGenerationFailure({
      code: 'INTEGRITY',
      detail: [{ path: 'nodes[0].children[0].estimateHours', message: '超出范围' }],
    });

    expect(failure.detail).toBe('nodes[0].children[0].estimateHours：超出范围');
  });

  it('falls back to the provider message for unknown codes', () => {
    const failure = mapGenerationFailure({
      code: 'PROVIDER_ERROR',
      message: '模型服务返回了异常状态（418）。',
      retryable: true,
    });

    expect(failure).toMatchObject({
      title: '模型服务异常',
      retryable: true,
      autoRetried: false,
    });
  });
});
