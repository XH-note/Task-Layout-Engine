import { describe, expect, it } from 'vitest';

import {
  maskKey,
  parseExtraBody,
  resolveCapability,
  validateBaseUrl,
  validateSettingsDraft,
} from './settings';

describe('parseExtraBody', () => {
  it('accepts an empty value as an empty object', () => {
    expect(parseExtraBody('   ')).toEqual({ ok: true, value: {} });
  });

  it('accepts a JSON object', () => {
    expect(parseExtraBody('{"thinking":{"type":"enabled"}}')).toEqual({
      ok: true,
      value: { thinking: { type: 'enabled' } },
    });
  });

  it('reports the line and column of invalid JSON', () => {
    const result = parseExtraBody('{\n  "a": 1,\n  "b": \n}');

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EXTRA_BODY');
    expect(result.error.line).toBe(4);
    expect(result.error.column).toBeGreaterThan(0);
  });

  it('rejects JSON values that are not objects', () => {
    expect(parseExtraBody('[]').ok).toBe(false);
    expect(parseExtraBody('null').ok).toBe(false);
    expect(parseExtraBody('"text"').ok).toBe(false);
  });
});

describe('maskKey', () => {
  it('keeps a short prefix and the last four characters', () => {
    expect(maskKey('sk-1234567890abcd')).toBe('sk-…abcd');
  });

  it('never returns the complete key for short keys', () => {
    const key = 'abcd';
    expect(maskKey(key)).not.toBe(key);
    expect(maskKey(key)).not.toContain(key);
  });
});

describe('validateBaseUrl', () => {
  it('removes a trailing slash without adding /v1', () => {
    expect(validateBaseUrl(' https://api.deepseek.com/v1/ ')).toEqual({
      ok: true,
      value: 'https://api.deepseek.com/v1',
    });
  });

  it('rejects a URL without a protocol', () => {
    expect(validateBaseUrl('api.deepseek.com/v1').ok).toBe(false);
  });
});

describe('resolveCapability', () => {
  it('uses native JSON Schema for OpenAI', () => {
    expect(resolveCapability('https://api.openai.com/v1', 'gpt-4o-mini')).toBe(
      'native_json_schema',
    );
  });

  it('uses prompted JSON mode for DeepSeek', () => {
    expect(resolveCapability('https://api.deepseek.com/v1', 'deepseek-flash')).toBe(
      'json_object_prompted',
    );
  });

  it('falls back to prompted JSON mode for unknown providers', () => {
    expect(resolveCapability('https://llm.example.com/v1', 'custom-model')).toBe(
      'json_object_prompted',
    );
  });
});

describe('validateSettingsDraft', () => {
  it('normalizes a complete draft', () => {
    const result = validateSettingsDraft({
      baseUrl: 'https://api.deepseek.com/v1/',
      model: ' deepseek-flash ',
      extraBody: '{"thinking":{"type":"enabled"}}',
      apiKey: ' sk-test ',
      persistKey: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        extraBody: '{"thinking":{"type":"enabled"}}',
        apiKey: 'sk-test',
        persistKey: true,
      },
    });
  });

  it('returns the position of invalid extra body JSON', () => {
    const result = validateSettingsDraft({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      extraBody: '{"a": }',
      persistKey: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EXTRA_BODY');
    expect(result.error.field).toBe('extraBody');
    expect(result.error.line).toBe(1);
    expect(result.error.column).toBeGreaterThan(0);
  });
});
