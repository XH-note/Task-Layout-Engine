import { useEffect, useState } from 'react';

import {
  formatElapsed,
  getGenerationStage,
  GENERATION_STAGES,
} from './generation-progress';

export const RETAINED_SOURCE_NOTE = '原文已保留，可以调整后重试。';

function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return Math.max(0, now - startedAt);
}

export function GenerationProgress({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt);
  const activeStage = getGenerationStage(elapsed);

  return (
    <div className="generation-progress">
      <div className="skeleton-sheet" aria-hidden="true">
        <span className="skeleton-line skeleton-line-title" />
        <span className="skeleton-line skeleton-line-wide" />
        <span className="skeleton-line skeleton-line-medium" />
        <span className="skeleton-line skeleton-line-short" />
        <span className="skeleton-line skeleton-line-wide" />
        <span className="skeleton-line skeleton-line-medium" />
      </div>

      <div className="generation-copy">
        <p className="generation-kicker">正在整理任务计划书</p>
        <ol className="generation-steps">
          {GENERATION_STAGES.map((stage, index) => {
            const state =
              index < activeStage ? 'done' : index === activeStage ? 'active' : '';

            return (
              <li className={state} key={stage}>
                <span className="generation-step-mark" aria-hidden="true">
                  {index < activeStage ? '✓' : index + 1}
                </span>
                <span>{stage}</span>
              </li>
            );
          })}
        </ol>
        <p className="generation-elapsed">已耗时 {formatElapsed(elapsed)}</p>
      </div>
    </div>
  );
}

export function GenerationInterrupted({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="generation-interrupted" role="status">
      <p>上次生成未完成，请重新生成。</p>
      <button className="text-button" type="button" onClick={onDismiss}>
        知道了
      </button>
    </div>
  );
}

export function GenerationBusy({
  canRetry,
  onRetry,
  onBack,
}: {
  canRetry: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="generation-error generation-busy" role="status">
      <span className="generation-error-mark" aria-hidden="true">
        …
      </span>
      <div>
        <h3>正在生成</h3>
        <p>已有生成任务正在进行，请稍后再试。</p>
        <div className="generation-error-actions">
          <button className="primary-button" type="button" onClick={onRetry} disabled={!canRetry}>
            重试
          </button>
          <button className="secondary-button" type="button" onClick={onBack}>
            返回修改输入
          </button>
        </div>
      </div>
    </div>
  );
}

export function GenerationError({
  message,
  canRetry,
  onRetry,
  onBack,
}: {
  message: string;
  canRetry: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="generation-error" role="alert">
      <span className="generation-error-mark" aria-hidden="true">
        !
      </span>
      <div>
        <h3>生成失败</h3>
        <p>{message}</p>
        <p className="generation-error-note">{RETAINED_SOURCE_NOTE}</p>
        <div className="generation-error-actions">
          <button className="primary-button" type="button" onClick={onRetry} disabled={!canRetry}>
            重试
          </button>
          <button className="secondary-button" type="button" onClick={onBack}>
            返回修改输入
          </button>
        </div>
      </div>
    </div>
  );
}
