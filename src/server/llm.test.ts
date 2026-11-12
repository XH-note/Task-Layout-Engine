import { describe, expect, it } from 'vitest';

import type { CapabilityTier } from '../shared/settings';
import { AppError } from './errors';
import {
  buildGenerationRequestBody,
  callChatCompletion,
  type FetchLike,
} from './llm';
import type { ProviderConnectionSettings } from './provider';

function settings(
  capability: CapabilityTier,
  extraBody: Record<string, unknown> = {},
): ProviderConnectionSettings {
  return {
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: 'test-key',
    extraBody,
    capability,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completion(
  content: string,
  finishReason = 'stop',
  extra: Record<string, unknown> = {},
) {
  return {
    choices: [
      {
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
    ...extra,
  };
}

describe('buildGenerationRequestBody', () => {
  it('uses a strict json_schema response format for native providers', () => {
    const body = buildGenerationRequestBody(settings('native_json_schema'), {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(body).toMatchObject({
      model: 'test-model',
      temperature: 0,
      max_tokens: 8192,
      stream: false,
    });
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    });
  });

  it('uses json_object for prompted providers', () => {
    const body = buildGenerationRequestBody(settings('json_object_prompted'), {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses a strict function tool for tools_strict providers', () => {
    const body = buildGenerationRequestBody(settings('tools_strict'), {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(body.response_format).toBeUndefined();
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ strict: true }),
      }),
    ]);
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'emit_task_plan' },
    });
  });

  it('sends no structured-output hints for text_only providers', () => {
    const body = buildGenerationRequestBody(settings('text_only'), {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(body.response_format).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it('lets extraBody override standard keys', () => {
    const body = buildGenerationRequestBody(
      settings('json_object_prompted', { temperature: 0.2, custom_flag: true }),
      { messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(body.temperature).toBe(0.2);
    expect(body.custom_flag).toBe(true);
  });
});

describe('callChatCompletion', () => {
  it('parses content, finish reason and usage', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(completion('{"ok":true}', 'stop'));

    const result = await callChatCompletion(
      settings('text_only'),
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      content: '{"ok":true}',
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 34 },
    });
  });

  it('falls back to tool_call arguments when content is empty', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'emit_task_plan',
                    arguments: '{"title":"from tool"}',
                  },
                },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      });

    const result = await callChatCompletion(
      settings('tools_strict'),
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl },
    );

    expect(result.content).toBe('{"title":"from tool"}');
  });

  it('maps auth failures to a non-retryable 502', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: { message: 'bad key' } }, 401);

    const failure = await callChatCompletion(
      settings('json_object_prompted'),
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: 'PROVIDER_AUTH',
      status: 502,
      retryable: false,
    });
  });

  it('marks rate limits as retryable', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: { message: 'slow down' } }, 429);

    const failure = await callChatCompletion(
      settings('json_object_prompted'),
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      status: 502,
      retryable: true,
    });
  });

  it('maps aborts to a retryable timeout', async () => {
    const fetchImpl: FetchLike = async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    };

    const failure = await callChatCompletion(
      settings('json_object_prompted'),
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      status: 504,
      retryable: true,
    });
  });
});
