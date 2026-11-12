import { describe, expect, it } from 'vitest';

import { MAX_SOURCE_CODE_POINTS, countCodePoints, getSourceState } from './source';

describe('任务原文计数', () => {
  it('按 Unicode code point 计数，不按 UTF-16 码元计数', () => {
    expect(countCodePoints('任务')).toBe(2);
    expect(countCodePoints('😀')).toBe(1);
    expect(countCodePoints('e\u0301')).toBe(2);
  });

  it('把空白内容视为空，不能生成', () => {
    expect(getSourceState('')).toEqual({
      codePoints: 0,
      empty: true,
      overLimit: false,
      canGenerate: false,
    });

    expect(getSourceState('  \n\t')).toMatchObject({
      empty: true,
      canGenerate: false,
    });
  });

  it('恰好 20,000 个 code point 时可以生成', () => {
    const text = 'a'.repeat(MAX_SOURCE_CODE_POINTS);

    expect(getSourceState(text)).toEqual({
      codePoints: 20_000,
      empty: false,
      overLimit: false,
      canGenerate: true,
    });
  });

  it('超过 20,000 个 code point 时拒绝生成', () => {
    const text = '任'.repeat(MAX_SOURCE_CODE_POINTS + 1);

    expect(getSourceState(text)).toEqual({
      codePoints: 20_001,
      empty: false,
      overLimit: true,
      canGenerate: false,
    });
  });
});
