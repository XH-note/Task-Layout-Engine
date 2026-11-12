export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-flash';

export const MODEL_PRESETS = [
  { value: 'deepseek-flash', label: 'DeepSeek Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
] as const;

export type CapabilityTier =
  | 'native_json_schema'
  | 'json_object_prompted'
  | 'tools_strict'
  | 'text_only';

export const CAPABILITY_LABELS: Record<CapabilityTier, string> = {
  native_json_schema: '原生 JSON Schema',
  json_object_prompted: 'JSON 模式 + 提示词',
  tools_strict: '严格工具调用',
  text_only: '纯文本 + 客户端校验',
};

export type ExtraBody = Record<string, unknown>;

export interface SettingsDraft {
  baseUrl: string;
  model: string;
  extraBody: string;
  apiKey?: string;
  persistKey: boolean;
}

export interface PublicSettings {
  baseUrl: string;
  model: string;
  extraBody: ExtraBody;
  hasKey: boolean;
  keyMask: string | null;
  keySource: 'saved' | 'session' | 'none';
  capability: CapabilityTier;
}

export interface TestConnectionSuccess {
  ok: true;
  capability: CapabilityTier;
  latencyMs: number;
  status: number;
}

export interface TestConnectionFailure {
  ok: false;
  capability: CapabilityTier;
  latencyMs: number;
  status?: number;
  code: string;
  message: string;
}

export type TestConnectionResult = TestConnectionSuccess | TestConnectionFailure;

export interface SettingsError {
  code: string;
  message: string;
  field?: string;
  line?: number;
  column?: number;
}

export type ParseExtraBodyResult =
  | { ok: true; value: ExtraBody }
  | { ok: false; error: SettingsError };

export type SettingsValidationResult =
  | { ok: true; value: SettingsDraft }
  | { ok: false; error: SettingsError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lineColumnAt(source: string, position: number): { line: number; column: number } {
  const safePosition = Math.max(0, Math.min(position, source.length));
  const before = source.slice(0, safePosition);
  const lines = before.split('\n');

  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

class JsonSourceError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

function parseJsonSource(source: string): { ok: true; value: unknown } | { ok: false; error: SettingsError } {
  let index = 0;

  const fail = (reason: string): never => {
    const { line, column } = lineColumnAt(source, index);
    throw new JsonSourceError(reason, line, column);
  };

  const skipWhitespace = () => {
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      index += 1;
    }
  };

  const parseString = (): string => {
    if (source[index] !== '"') fail('字符串必须用双引号包裹');
    index += 1;
    let value = '';

    while (index < source.length) {
      const char = source[index];

      if (char === '"') {
        index += 1;
        return value;
      }

      if (char === '\\') {
        index += 1;
        const escape = source[index];
        if (escape === undefined) fail('字符串没有闭合');

        const escapes: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };

        if (escape === 'u') {
          const hex = source.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('字符串中的 Unicode 转义不完整');
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 5;
          continue;
        }

        const replacement = escapes[escape];
        if (replacement === undefined) fail(`字符串中包含无效转义 \\${escape}`);
        value += replacement;
        index += 1;
        continue;
      }

      if (char.charCodeAt(0) < 0x20) fail('字符串中包含未转义的控制字符');

      value += char;
      index += 1;
    }

    return fail('字符串没有闭合');
  };

  const parseNumber = (): number => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (!match) return fail('数字格式不正确');

    index += match[0].length;
    return Number(match[0]);
  };

  const parseObject = (): Record<string, unknown> => {
    index += 1;
    const value: Record<string, unknown> = {};
    skipWhitespace();

    if (source[index] === '}') {
      index += 1;
      return value;
    }

    while (true) {
      skipWhitespace();
      if (source[index] !== '"') fail('属性名必须用双引号包裹');
      const key = parseString();
      skipWhitespace();
      if (source[index] !== ':') fail('属性名后需要冒号');
      index += 1;
      skipWhitespace();
      value[key] = parseValue();
      skipWhitespace();

      if (source[index] === ',') {
        index += 1;
        skipWhitespace();
        if (source[index] === '}') fail('对象末尾不能有多余逗号');
        continue;
      }

      if (source[index] === '}') {
        index += 1;
        return value;
      }

      fail('对象成员之间需要逗号，或在这里结束对象');
    }
  };

  const parseArray = (): unknown[] => {
    index += 1;
    const value: unknown[] = [];
    skipWhitespace();

    if (source[index] === ']') {
      index += 1;
      return value;
    }

    while (true) {
      skipWhitespace();
      value.push(parseValue());
      skipWhitespace();

      if (source[index] === ',') {
        index += 1;
        skipWhitespace();
        if (source[index] === ']') fail('数组末尾不能有多余逗号');
        continue;
      }

      if (source[index] === ']') {
        index += 1;
        return value;
      }

      fail('数组元素之间需要逗号，或在这里结束数组');
    }
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    const char = source[index];

    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return parseNumber();

    if (source.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (source.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (source.startsWith('null', index)) {
      index += 4;
      return null;
    }

    return fail('这里需要一个 JSON 值');
  };

  try {
    const value = parseValue();
    skipWhitespace();
    if (index < source.length) fail('JSON 结束后还有多余内容');
    return { ok: true, value };
  } catch (error) {
    if (error instanceof JsonSourceError) {
      return {
        ok: false,
        error: {
          code: 'INVALID_EXTRA_BODY',
          message: `额外请求体不是合法 JSON：第 ${error.line} 行第 ${error.column} 列附近有问题（${error.message}）。`,
          field: 'extraBody',
          line: error.line,
          column: error.column,
        },
      };
    }

    throw error;
  }
}

export function parseExtraBody(text: string): ParseExtraBodyResult {
  const source = text.trim();

  if (!source) {
    return { ok: true, value: {} };
  }

  const parsed = parseJsonSource(source);
  if (!parsed.ok) return parsed;

  if (!isRecord(parsed.value)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_EXTRA_BODY',
        message: '额外请求体必须是 JSON 对象，例如 {"thinking":{"type":"enabled"}}。',
        field: 'extraBody',
        line: 1,
        column: 1,
      },
    };
  }

  return { ok: true, value: parsed.value };
}

export function validateBaseUrl(raw: string): { ok: true; value: string } | { ok: false; error: SettingsError } {
  const value = raw.trim();

  if (!value) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BASE_URL',
        message: '请填写 base_url，例如 https://api.deepseek.com/v1。',
        field: 'baseUrl',
      },
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_BASE_URL',
        message: 'base_url 不是合法地址，请填写完整 URL（包含 http:// 或 https://）。',
        field: 'baseUrl',
      },
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      error: {
        code: 'INVALID_BASE_URL',
        message: 'base_url 只支持 http:// 或 https:// 地址。',
        field: 'baseUrl',
      },
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BASE_URL',
        message: 'base_url 不应包含用户名或密码，请把 API key 填在单独字段。',
        field: 'baseUrl',
      },
    };
  }

  if (url.search || url.hash) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BASE_URL',
        message: 'base_url 不应包含查询参数或锚点，请只填写到 /v1 这一层。',
        field: 'baseUrl',
      },
    };
  }

  return { ok: true, value: url.toString().replace(/\/$/, '') };
}

export function maskKey(key: string): string {
  const value = key.trim();
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(Math.max(4, value.length));
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export function resolveCapability(baseUrl: string, model: string): CapabilityTier {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }

  if (host === 'api.openai.com') return 'native_json_schema';
  if (host.endsWith('deepseek.com')) return 'json_object_prompted';
  if (/^(gpt-|o\d)/i.test(model.trim())) return 'native_json_schema';

  return 'json_object_prompted';
}

export function validateSettingsDraft(input: unknown): SettingsValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SETTINGS',
        message: '设置内容格式不正确。',
      },
    };
  }

  const baseUrl = validateBaseUrl(typeof input.baseUrl === 'string' ? input.baseUrl : '');
  if (!baseUrl.ok) return baseUrl;

  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MODEL',
        message: '请填写模型名，例如 deepseek-flash。',
        field: 'model',
      },
    };
  }

  if (model.length > 120) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MODEL',
        message: '模型名过长，请填写 120 个字符以内的模型名。',
        field: 'model',
      },
    };
  }

  if (typeof input.extraBody !== 'string') {
    return {
      ok: false,
      error: {
        code: 'INVALID_EXTRA_BODY',
        message: '额外请求体必须以 JSON 文本提交。',
        field: 'extraBody',
      },
    };
  }

  const extraBody = parseExtraBody(input.extraBody);
  if (!extraBody.ok) return extraBody;

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';

  return {
    ok: true,
    value: {
      baseUrl: baseUrl.value,
      model,
      extraBody: JSON.stringify(extraBody.value),
      apiKey: apiKey || undefined,
      persistKey: typeof input.persistKey === 'boolean' ? input.persistKey : true,
    },
  };
}
