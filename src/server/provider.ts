import type {
  CapabilityTier,
  ExtraBody,
  TestConnectionFailure,
  TestConnectionResult,
} from '../shared/settings';

export type { TestConnectionResult } from '../shared/settings';

export interface ProviderConnectionSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  extraBody: ExtraBody;
  capability: CapabilityTier;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type SleepLike = (milliseconds: number) => Promise<void>;

const TEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 500;

const defaultSleep: SleepLike = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function joinChatCompletions(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

export function buildTestRequestBody(settings: ProviderConnectionSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...settings.extraBody,
    model: settings.model,
    messages: [
      {
        role: 'user',
        content: '只输出一个 JSON 对象：{"ok":true}。',
      },
    ],
    temperature: 0,
    max_tokens: 16,
    stream: false,
  };

  delete body.response_format;
  delete body.tools;
  delete body.tool_choice;

  if (settings.capability === 'native_json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'connection_probe',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    };
  } else if (settings.capability === 'json_object_prompted') {
    body.response_format = { type: 'json_object' };
  } else if (settings.capability === 'tools_strict') {
    body.tools = [
      {
        type: 'function',
        function: {
          name: 'report_connection',
          description: 'Return a small connection probe result.',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
            },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
    ];
    body.tool_choice = {
      type: 'function',
      function: { name: 'report_connection' },
    };
  }

  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readErrorDetail(response: Response): Promise<string> {
  let text: string;

  try {
    text = await response.text();
  } catch {
    return '';
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === 'string') {
        return error.message.slice(0, 300);
      }
      if (typeof parsed.message === 'string') {
        return parsed.message.slice(0, 300);
      }
    }
  } catch {
    // Fall back to the raw response text.
  }

  return text.trim().slice(0, 300);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

function failure(
  capability: CapabilityTier,
  latencyMs: number,
  code: string,
  message: string,
  status?: number,
): TestConnectionFailure {
  return {
    ok: false,
    capability,
    latencyMs,
    ...(status === undefined ? {} : { status }),
    code,
    message,
  };
}

export async function testProviderConnection(
  settings: ProviderConnectionSettings,
  options: { fetchImpl?: FetchLike; sleep?: SleepLike } = {},
): Promise<TestConnectionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = Date.now();
  const body = JSON.stringify(buildTestRequestBody(settings));
  let lastNetworkError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;

    try {
      response = await fetchImpl(joinChatCompletions(settings.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isAbortError(error)) {
        return failure(
          settings.capability,
          Date.now() - startedAt,
          'TIMEOUT',
          '连接超时（15 秒），请检查 base_url 或网络。',
        );
      }

      lastNetworkError = error;
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      return failure(
        settings.capability,
        Date.now() - startedAt,
        'NETWORK_ERROR',
        '无法连接到模型服务，已重试一次仍失败，请检查 base_url 和网络。',
      );
    }

    if (response.ok) {
      return {
        ok: true,
        capability: settings.capability,
        latencyMs: Date.now() - startedAt,
        status: response.status,
      };
    }

    const status = response.status;
    const detail = await readErrorDetail(response);
    const latencyMs = Date.now() - startedAt;

    if ((status === 429 || status >= 500) && attempt === 0) {
      await sleep(status === 429 ? 1_000 : RETRY_DELAY_MS);
      continue;
    }

    if (status === 401) {
      return failure(
        settings.capability,
        latencyMs,
        'AUTH_FAILED',
        '鉴权失败（401）：API key 无效或不再有效。',
        status,
      );
    }

    if (status === 403) {
      return failure(
        settings.capability,
        latencyMs,
        'FORBIDDEN',
        '请求被拒绝（403）：请检查 API key 的权限或 base_url。',
        status,
      );
    }

    if (status === 429) {
      return failure(
        settings.capability,
        latencyMs,
        'RATE_LIMITED',
        '请求过于频繁（429），已重试一次仍失败，请稍后再试。',
        status,
      );
    }

    if (status === 400) {
      return failure(
        settings.capability,
        latencyMs,
        'BAD_REQUEST',
        `请求被拒绝（400）：${detail || '请检查 base_url、模型名和额外请求体。'}`,
        status,
      );
    }

    if (status >= 500) {
      return failure(
        settings.capability,
        latencyMs,
        'PROVIDER_ERROR',
        `模型服务暂时不可用（HTTP ${status}），已重试一次仍失败。`,
        status,
      );
    }

    return failure(
      settings.capability,
      latencyMs,
      'HTTP_ERROR',
      `连接测试失败（HTTP ${status}）${detail ? `：${detail}` : '。'}`,
      status,
    );
  }

  const detail = lastNetworkError instanceof Error ? `：${lastNetworkError.message}` : '';
  return failure(
    settings.capability,
    Date.now() - startedAt,
    'NETWORK_ERROR',
    `无法连接到模型服务${detail}`,
  );
}
