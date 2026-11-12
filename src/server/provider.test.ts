import { describe, expect, it, vi } from 'vitest';

import {
  buildTestRequestBody,
  testProviderConnection,
  type FetchLike,
  type ProviderConnectionSettings,
} from './provider';

function settings(overrides: Partial<ProviderConnectionSettings> = {}): ProviderConnectionSettings {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    apiKey: 'sk-test-1234',
    extraBody: {},
    capability: 'json_object_prompted',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('buildTestRequestBody', () => {
  it('uses a small deterministic JSON-mode request', () => {
    const body = buildTestRequestBody(settings());

    expect(body).toMatchObject({
      model: 'deepseek-flash',
      temperature: 0,
      max_tokens: 16,
      stream: false,
      response_format: { type: 'json_object' },
    });
  });

  it('uses native JSON Schema for capable providers', () => {
    const body = buildTestRequestBody(
      settings({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        capability: 'native_json_schema',
      }),
    );

    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'connection_probe', strict: true },
    });
  });
});

describe('testProviderConnection', () => {
  it('returns the capability and latency on success', async () => {
    const mockFetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ choices: [] }),
    );
    const fetchImpl = mockFetch as unknown as FetchLike;

    const result = await testProviderConnection(settings(), { fetchImpl });

    expect(result).toMatchObject({
      ok: true,
      capability: 'json_object_prompted',
      status: 200,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer sk-test-1234',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      max_tokens: 16,
      stream: false,
    });
  });

  it('retries a 5xx response once', async () => {
    const mockFetch = vi
      .fn(async (_url: string, _init: RequestInit) => jsonResponse({ choices: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'busy' } }, 503))
      .mockResolvedValueOnce(jsonResponse({ choices: [] }));
    const fetchImpl = mockFetch as unknown as FetchLike;
    const sleep = vi.fn(async () => undefined);

    const result = await testProviderConnection(settings(), { fetchImpl, sleep });

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 401 response', async () => {
    const mockFetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ error: { message: 'invalid key' } }, 401),
    );
    const fetchImpl = mockFetch as unknown as FetchLike;

    const result = await testProviderConnection(settings(), { fetchImpl });

    expect(result).toMatchObject({
      ok: false,
      code: 'AUTH_FAILED',
      status: 401,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('includes the provider detail for a 400 response', async () => {
    const mockFetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ error: { message: 'unsupported response_format' } }, 400),
    );
    const fetchImpl = mockFetch as unknown as FetchLike;

    const result = await testProviderConnection(settings(), { fetchImpl });

    expect(result).toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
      status: 400,
    });
    expect(result.ok ? '' : result.message).toContain('unsupported response_format');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns a readable network error after one retry', async () => {
    const mockFetch = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const fetchImpl = mockFetch as unknown as FetchLike;
    const sleep = vi.fn(async () => undefined);

    const result = await testProviderConnection(settings(), { fetchImpl, sleep });

    expect(result).toMatchObject({
      ok: false,
      code: 'NETWORK_ERROR',
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
