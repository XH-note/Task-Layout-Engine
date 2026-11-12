import { describe, expect, it, vi } from 'vitest';

import type { PlanRecord } from '../shared/plan';
import { GenerationService } from './generation';
import type { CallModel, ChatResult } from './llm';

const SOURCE = '把旧系统迁移到新平台。';

function serviceWith(callModel: CallModel, create = vi.fn(async (record: PlanRecord) => record)) {
  return {
    create,
    service: new GenerationService({
      settingsStore: {
        getResolved: async () => ({
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
          extraBody: {},
          hasKey: true,
          keyMask: 'sk-…test',
          keySource: 'saved',
          capability: 'json_object_prompted',
          apiKey: 'test-key',
        }),
      },
      planStore: { create },
      callModel,
    }),
  };
}

describe('GenerationService cancellation', () => {
  it('aborts the in-flight model call and persists nothing', async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const callModel: CallModel = async (_settings, request) =>
      new Promise<ChatResult>((_resolve, reject) => {
        markStarted();
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (request.signal?.aborted) {
          abort();
          return;
        }
        request.signal?.addEventListener('abort', abort, { once: true });
      });
    const { service, create } = serviceWith(callModel);
    const controller = new AbortController();

    const generating = service.generate(SOURCE, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(generating).rejects.toMatchObject({
      code: 'CANCELLED',
      status: 499,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not start a model call when the request is already cancelled', async () => {
    const callModel = vi.fn(async (): Promise<ChatResult> => {
      throw new Error('model should not be called');
    });
    const { service, create } = serviceWith(callModel);
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.generate(SOURCE, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(callModel).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
