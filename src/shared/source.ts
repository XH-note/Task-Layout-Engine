export const MAX_SOURCE_CODE_POINTS = 20_000;

export type SourceState = {
  codePoints: number;
  empty: boolean;
  overLimit: boolean;
  canGenerate: boolean;
};

export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

export function getSourceState(text: string): SourceState {
  const codePoints = countCodePoints(text);
  const empty = text.trim().length === 0;
  const overLimit = codePoints > MAX_SOURCE_CODE_POINTS;

  return {
    codePoints,
    empty,
    overLimit,
    canGenerate: !empty && !overLimit,
  };
}
