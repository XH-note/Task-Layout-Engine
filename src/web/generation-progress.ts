export const GENERATION_STAGES = [
  '整理输入',
  '生成计划',
  '校验结构',
  '马上就好',
] as const;

const STAGE_START_MS = [0, 2_000, 5_000, 10_000] as const;

export const CANCEL_AFTER_MS = 60_000;

export function getGenerationStage(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }

  for (let index = STAGE_START_MS.length - 1; index > 0; index -= 1) {
    if (elapsedMs >= STAGE_START_MS[index]) {
      return index;
    }
  }

  return 0;
}

export function canCancelGeneration(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= CANCEL_AFTER_MS;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.floor(elapsedMs / 1_000))
    : 0;
  const minutes = Math.floor(totalSeconds / 60);

  if (minutes === 0) {
    return `${totalSeconds} 秒`;
  }

  return `${minutes} 分 ${totalSeconds % 60} 秒`;
}
