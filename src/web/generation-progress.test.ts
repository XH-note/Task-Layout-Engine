import { describe, expect, it } from 'vitest';

import {
  canCancelGeneration,
  formatElapsed,
  getGenerationStage,
  GENERATION_STAGES,
} from './generation-progress';

describe('GENERATION_STAGES', () => {
  it('uses the four copy stages from the spec in order', () => {
    expect(GENERATION_STAGES).toEqual([
      '整理输入',
      '生成计划',
      '校验结构',
      '马上就好',
    ]);
  });
});

describe('getGenerationStage', () => {
  it('advances through the four stages as time passes', () => {
    expect(getGenerationStage(0)).toBe(0);
    expect(getGenerationStage(1_999)).toBe(0);
    expect(getGenerationStage(2_000)).toBe(1);
    expect(getGenerationStage(4_999)).toBe(1);
    expect(getGenerationStage(5_000)).toBe(2);
    expect(getGenerationStage(9_999)).toBe(2);
    expect(getGenerationStage(10_000)).toBe(3);
    expect(getGenerationStage(120_000)).toBe(3);
  });

  it('clamps invalid elapsed values to the first stage', () => {
    expect(getGenerationStage(-1)).toBe(0);
    expect(getGenerationStage(Number.NaN)).toBe(0);
  });
});

describe('canCancelGeneration', () => {
  it('allows cancellation only after 60 seconds', () => {
    expect(canCancelGeneration(59_999)).toBe(false);
    expect(canCancelGeneration(60_000)).toBe(true);
    expect(canCancelGeneration(90_000)).toBe(true);
  });
});

describe('formatElapsed', () => {
  it('formats whole seconds and minutes', () => {
    expect(formatElapsed(0)).toBe('0 秒');
    expect(formatElapsed(1_500)).toBe('1 秒');
    expect(formatElapsed(65_000)).toBe('1 分 5 秒');
  });

  it('never shows negative time', () => {
    expect(formatElapsed(-4_000)).toBe('0 秒');
  });
});
