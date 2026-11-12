import type { CapabilityTier } from '../shared/settings';
import { WIRE_PLAN_JSON_SCHEMA } from '../shared/wire';
import { AppError } from './errors';
import type { ProviderConnectionSettings } from './provider';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  finishReason: string;
  usage: ChatUsage | null;
  raw: unknown;
}

export type CallModel = (
  settings: ProviderConnectionSettings,
  request: ChatRequest,
) => Promise<ChatResult>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const GENERATION_MAX_TOKENS = 8192;
export const GENERATION_TIMEOUT_MS = 120_000;

const WIRE_SCHEMA_NAME = 'emit_task_plan';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinChatCompletions(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function responseFormatFor(capability: CapabilityTier): Record<string, unknown> | null {
  if (capability === 'native_json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: WIRE_SCHEMA_NAME,
        strict: true,
        schema: WIRE_PLAN_JSON_SCHEMA,
      },
    };
  }

  if (capability === 'json_object_prompted') {
    return { type: 'json_object' };
  }

  return null;
}

export function buildGenerationRequestBody(
  settings: ProviderConnectionSettings,
  request: ChatRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: request.messages,
    temperature: 0,
    max_tokens: request.maxTokens ?? GENERATION_MAX_TOKENS,
    stream: false,
  };

  const responseFormat = responseFormatFor(settings.capability);

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  if (settings.capability === 'tools_strict') {
    body.tools = [
      {
        type: 'function',
        function: {
          name: WIRE_SCHEMA_NAME,
          description: 'Return the complete task plan as structured JSON.',
          strict: true,
          parameters: WIRE_PLAN_JSON_SCHEMA,
        },
      },
    ];
    body.tool_choice = { type: 'function', function: { name: WIRE_SCHEMA_NAME } };
  }

  return { ...body, ...settings.extraBody };
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
        return error.message.slice(0, 500);
      }
      if (typeof parsed.message === 'string') {
        return parsed.message.slice(0, 500);
      }
    }
  } catch {
    // Fall back to the raw response text.
  }

  return text.trim().slice(0, 500);
}

function providerFailure(status: number, detail: string): AppError {
  if (status === 401 || status === 403) {
    return new AppError('PROVIDER_AUTH', 502, '模型服务拒绝了认证，请检查 API Key。', {
      detail: detail || null,
    });
  }

  if (status === 429) {
    return new AppError('PROVIDER_RATE_LIMIT', 502, '模型服务限流，请稍后重试。', {
      retryable: true,
      detail: detail || null,
    });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new AppError(
      'PROVIDER_BAD_REQUEST',
      502,
      '模型服务拒绝了请求，请检查 base URL、模型名称或额外请求体。',
      { detail: detail || null },
    );
  }

  if (status >= 500) {
    return new AppError('PROVIDER_SERVER', 502, '模型服务暂时不可用，请稍后重试。', {
      retryable: true,
      detail: detail || null,
    });
  }

  return new AppError('PROVIDER_ERROR', 502, `模型服务返回了异常状态（${status}）。`, {
    detail: detail || null,
  });
}

function extractContent(message: Record<string, unknown>): string {
  const content = message.content;

  if (typeof content === 'string' && content.trim() !== '') return content;

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter((part) => part.length > 0)
      .join('');

    if (text.trim() !== '') return text;
  }

  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const call = toolCalls[0];
    if (isRecord(call) && isRecord(call.function)) {
      const args = call.function.arguments;
      if (typeof args === 'string') return args;
      if (isRecord(args)) return JSON.stringify(args);
    }
  }

  return typeof content === 'string' ? content : '';
}

function extractUsage(payload: Record<string, unknown>): ChatUsage | null {
  const usage = payload.usage;
  if (!isRecord(usage)) return null;

  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;

  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') {
    return null;
  }

  return { promptTokens, completionTokens };
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

export async function callChatCompletion(
  settings: ProviderConnectionSettings,
  request: ChatRequest,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ChatResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify(buildGenerationRequestBody(settings, request));

  let response: Response;

  try {
    response = await fetchImpl(joinChatCompletions(settings.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(request.timeoutMs ?? GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new AppError('PROVIDER_TIMEOUT', 504, '模型服务响应超时，请稍后重试。', {
        retryable: true,
      });
    }

    throw new AppError('PROVIDER_NETWORK', 502, '无法连接模型服务，请检查网络或 base URL。', {
      retryable: true,
      detail: error instanceof Error ? error.message : null,
    });
  }

  if (!response.ok) {
    throw providerFailure(response.status, await readErrorDetail(response));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError('PROVIDER_BAD_RESPONSE', 502, '模型服务返回了无法解析的响应。');
  }

  if (!isRecord(payload)) {
    throw new AppError('PROVIDER_BAD_RESPONSE', 502, '模型服务返回了无法解析的响应。');
  }

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new AppError('PROVIDER_BAD_RESPONSE', 502, '模型服务没有返回候选结果。');
  }

  const choice = choices[0];
  const message = isRecord(choice.message) ? choice.message : {};
  const finishReason =
    typeof choice.finish_reason === 'string' ? choice.finish_reason : '';

  return {
    content: extractContent(message),
    finishReason,
    usage: extractUsage(payload),
    raw: payload,
  };
}
