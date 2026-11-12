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

  constructor(error: SettingsError) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.field = error.field;
    this.line = error.line;
    this.column = error.column;
  }
}

interface ErrorEnvelope {
  error?: SettingsError;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: '无法连接到本地服务，请确认服务正在运行后重试。',
    });
  }

  const text = await response.text();

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
