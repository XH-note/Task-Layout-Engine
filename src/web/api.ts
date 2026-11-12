import type { PlanRecord } from '../shared/plan';
import type {
  PublicSettings,
  SettingsDraft,
  SettingsError,
  TestConnectionResult,
} from '../shared/settings';

export class ApiError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly line?: number;
  readonly column?: number;
  readonly detail?: unknown;
  readonly retryable: boolean;

  constructor(error: SettingsError & { detail?: unknown; retryable?: boolean }) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.field = error.field;
    this.line = error.line;
    this.column = error.column;
    this.detail = error.detail;
    this.retryable = error.retryable ?? false;
  }
}

interface ErrorEnvelope {
  error?: SettingsError & { detail?: unknown; retryable?: boolean };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function cancelledError(): ApiError {
  return new ApiError({ code: 'CANCELLED', message: '已取消生成。' });
}

function networkError(): ApiError {
  return new ApiError({
    code: 'NETWORK_ERROR',
    message: '无法连接到本地服务，请确认服务正在运行后重试。',
  });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbortError(error)) throw cancelledError();
    throw networkError();
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) throw cancelledError();
    throw networkError();
  }

  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const envelope = payload as ErrorEnvelope | null;
    const error = envelope?.error;

    throw new ApiError({
      code: error?.code ?? 'REQUEST_FAILED',
      message: error?.message ?? `请求失败（HTTP ${response.status}）。`,
      field: error?.field,
      line: error?.line,
      column: error?.column,
      detail: error?.detail,
      retryable: error?.retryable,
    });
  }

  return payload as T;
}

export function getSettings(): Promise<PublicSettings> {
  return request<PublicSettings>('/api/settings');
}

export function saveSettings(draft: SettingsDraft): Promise<PublicSettings> {
  return request<PublicSettings>('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

export function testConnection(draft: SettingsDraft): Promise<TestConnectionResult> {
  return request<TestConnectionResult>('/api/settings/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

export function generatePlan(
  source: string,
  signal?: AbortSignal,
): Promise<{ record: PlanRecord }> {
  return request<{ record: PlanRecord }>('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
    ...(signal ? { signal } : {}),
  });
}

export function getPlan(id: string): Promise<PlanRecord> {
  return request<PlanRecord>(`/api/plans/${encodeURIComponent(id)}`);
}
