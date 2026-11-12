import { useEffect, useRef, useState } from 'react';

import { MAX_SOURCE_CODE_POINTS, getSourceState } from '../shared/source';
import {
  GenerationBusy,
  GenerationError,
  GenerationInterrupted,
  GenerationNotice,
  GenerationProgress,
  RETAINED_SOURCE_NOTE,
} from './GenerationFeedback';
import HistoryMenu from './HistoryMenu';
import Inspector from './Inspector';
import PlanDocument from './PlanDocument';
import SettingsDialog from './SettingsDialog';
import { usePlanStore } from './plan-store';
import type { GenerationPhase } from './plan-store';
import { useWorkbenchStore } from './store';

const ACTIVE_STATUS: Record<
  Exclude<GenerationPhase, 'idle'>,
  { label: string; className: string }
> = {
  generating: { label: '生成中', className: 'status-pill status-pill-generating' },
  busy: { label: '正在生成', className: 'status-pill status-pill-generating' },
  failed: { label: '生成失败', className: 'status-pill status-pill-failed' },
};

function getWorkbenchView({
  overLimit,
  empty,
  phase,
  hasRecord,
}: {
  overLimit: boolean;
  empty: boolean;
  phase: GenerationPhase;
  hasRecord: boolean;
}): {
  statusLabel: string;
  statusClass: string;
  helperText: string;
  disabledReason: string | null;
} {
  const status =
    phase === 'idle'
      ? hasRecord
        ? { label: '已生成', className: 'status-pill status-pill-ready' }
        : { label: '尚未生成', className: 'status-pill' }
      : ACTIVE_STATUS[phase];

  let helperText: string;
  let disabledReason: string | null = null;

  if (overLimit) {
    helperText = '原文超出上限，请删减后再生成。';
    disabledReason = '原文超出上限';
  } else if (empty) {
    helperText = '先粘贴任务原文，再生成任务计划书。';
    disabledReason = '请先粘贴任务原文';
  } else if (phase === 'generating') {
    helperText = '正在生成任务计划书，通常需要几十秒。';
    disabledReason = '正在生成中';
  } else if (phase === 'busy') {
    helperText = '已有生成任务正在进行，请稍后再试。';
  } else if (phase === 'failed') {
    helperText = RETAINED_SOURCE_NOTE;
  } else if (hasRecord) {
    helperText = '已生成任务计划书；修改原文后可再次生成。';
  } else {
    helperText = '输入已就绪，可以生成任务计划书。';
  }

  return {
    statusLabel: status.label,
    statusClass: status.className,
    helperText,
    disabledReason,
  };
}

export default function App() {
  const source = useWorkbenchStore((state) => state.source);
  const setSource = useWorkbenchStore((state) => state.setSource);
  const clearSource = useWorkbenchStore((state) => state.clearSource);
  const record = usePlanStore((state) => state.record);
  const generation = usePlanStore((state) => state.generation);
  const interrupted = usePlanStore((state) => state.interrupted);
  const notice = usePlanStore((state) => state.notice);
  const restore = usePlanStore((state) => state.restore);
  const generate = usePlanStore((state) => state.generate);
  const cancel = usePlanStore((state) => state.cancel);
  const newPlan = usePlanStore((state) => state.newPlan);
  const selectedNodeId = usePlanStore((state) => state.selectedNodeId);
  const selectNode = usePlanStore((state) => state.selectNode);
  const saveState = usePlanStore((state) => state.saveState);
  const retrySave = usePlanStore((state) => state.retrySave);
  const renamePlan = usePlanStore((state) => state.renamePlan);
  const moveNode = usePlanStore((state) => state.moveNode);
  const dismissIssue = usePlanStore((state) => state.dismissIssue);
  const dismissInterrupted = usePlanStore((state) => state.dismissInterrupted);
  const dismissNotice = usePlanStore((state) => state.dismissNotice);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sourceState = getSourceState(source);
  const generating = generation.phase === 'generating';
  const view = getWorkbenchView({
    overLimit: sourceState.overLimit,
    empty: sourceState.empty,
    phase: generation.phase,
    hasRecord: record !== null,
  });

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    const flushPendingSave = () => {
      void usePlanStore.getState().saveNow({ keepalive: true });
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flushPendingSave();
    };

    window.addEventListener('pagehide', flushPendingSave);
    document.addEventListener('visibilitychange', flushWhenHidden);

    return () => {
      window.removeEventListener('pagehide', flushPendingSave);
      document.removeEventListener('visibilitychange', flushWhenHidden);
    };
  }, []);

  useEffect(() => {
    const guardUnsavedDraft = (event: BeforeUnloadEvent) => {
      if (!source.trim()) return;

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', guardUnsavedDraft);
    return () => window.removeEventListener('beforeunload', guardUnsavedDraft);
  }, [source]);

  const handleClear = () => {
    if (generating) cancel();
    clearSource();
    textareaRef.current?.focus();
  };

  const handleNewPlan = () => {
    void newPlan().then(() => {
      if (usePlanStore.getState().record !== null) return;
      clearSource();
      textareaRef.current?.focus();
    });
  };

  const handleGenerate = () => {
    void generate(source);
  };

  const handleCancel = () => {
    cancel();
    textareaRef.current?.focus();
  };

  const handleBackToEdit = () => {
    dismissIssue();
    dismissNotice();
    textareaRef.current?.focus();
  };

  const remaining = MAX_SOURCE_CODE_POINTS - sourceState.codePoints;
  const priorPlan = record ? (
    <div className="prior-plan">
      <p className="prior-plan-label">上次生成的计划书仍保留</p>
      <PlanDocument
        record={record}
        selectedNodeId={selectedNodeId}
        onSelectNode={selectNode}
        onRenamePlan={renamePlan}
        onMoveNode={moveNode}
      />
    </div>
  ) : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            排
          </span>
          <div className="brand-copy">
            <h1>任务排版器</h1>
            <p>把一段任务描述，整理成可执行的任务计划书</p>
          </div>
        </div>

        <nav className="topbar-actions" aria-label="全局操作">
          {saveState.status === 'saving' ? (
            <span className="save-status" role="status">
              保存中…
            </span>
          ) : saveState.status === 'dirty' ? (
            <span className="save-status" role="status">
              未保存
            </span>
          ) : saveState.status === 'invalid' ? (
            <span
              className="save-status save-status-error"
              role="status"
              title={saveState.message}
            >
              未保存 · 请修正
            </span>
          ) : saveState.status === 'error' ? (
            <button
              className="save-status save-status-error"
              type="button"
              onClick={() => void retrySave()}
              title={saveState.message}
            >
              未保存 · 重试
            </button>
          ) : null}
          <button className="quiet-button" type="button" onClick={handleNewPlan}>
            新建计划
          </button>
          <HistoryMenu />
          <button className="quiet-button" type="button" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
          <button className="export-button" type="button" disabled title="导出将在后续切片接入">
            导出
          </button>
        </nav>
      </header>

      <main className="workbench">
        <section className="panel source-panel" aria-labelledby="source-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">输入</p>
              <h2 id="source-title">任务原文</h2>
            </div>
            <span
              className={sourceState.overLimit ? 'count over-limit' : 'count'}
              aria-live="polite"
            >
              {sourceState.codePoints.toLocaleString('zh-CN')} /{' '}
              {MAX_SOURCE_CODE_POINTS.toLocaleString('zh-CN')}
            </span>
          </div>

          <p className="panel-hint">粘贴任务背景、目标、约束和已知风险。信息越具体，计划越可执行。</p>

          <textarea
            ref={textareaRef}
            className={sourceState.overLimit ? 'source-input over-limit' : 'source-input'}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="例如：下个月要把官网从旧域名迁移到新域名，涉及 DNS 切换、301 规则、回滚演练和对外公告……"
            aria-invalid={sourceState.overLimit}
            aria-describedby="source-counter-note"
            spellCheck={false}
            autoFocus
          />

          <div className="source-meta">
            <span id="source-counter-note" className={sourceState.overLimit ? 'meta-text warning' : 'meta-text'}>
              {sourceState.overLimit
                ? `已超出 ${Math.abs(remaining).toLocaleString('zh-CN')} 个字符`
                : `还可输入 ${remaining.toLocaleString('zh-CN')} 个字符`}
            </span>
            <button className="text-button" type="button" onClick={handleClear} disabled={source.length === 0}>
              清空
            </button>
          </div>

          <div className="source-footer">
            <p className={sourceState.overLimit ? 'helper-text warning' : 'helper-text'}>{view.helperText}</p>
            <button
              className="generate-button"
              type="button"
              onClick={handleGenerate}
              disabled={view.disabledReason !== null}
              title={view.disabledReason ?? undefined}
            >
              {generating ? '正在生成…' : record ? '再次生成任务计划书' : '生成任务计划书'}
            </button>
          </div>
        </section>

        <section className="panel document-panel" aria-labelledby="document-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">任务计划书</p>
              <h2 id="document-title">阅读视图</h2>
            </div>
            <span className={view.statusClass} role="status" aria-live="polite">
              {view.statusLabel}
            </span>
          </div>

          <div className="document-body" aria-busy={generating}>
            {interrupted && generation.phase === 'idle' ? (
              <GenerationInterrupted onDismiss={dismissInterrupted} />
            ) : null}

            {notice ? (
              <GenerationNotice message={notice} onDismiss={dismissNotice} />
            ) : null}

            {generation.phase === 'generating' ? (
              <GenerationProgress
                startedAt={generation.startedAt}
                onCancel={handleCancel}
              />
            ) : generation.phase === 'busy' ? (
              <>
                <GenerationBusy
                  canRetry={sourceState.canGenerate}
                  onRetry={handleGenerate}
                  onBack={handleBackToEdit}
                />
                {priorPlan}
              </>
            ) : generation.phase === 'failed' ? (
              <>
                <GenerationError
                  failure={generation.failure}
                  canRetry={sourceState.canGenerate}
                  onRetry={handleGenerate}
                  onBack={handleBackToEdit}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
                {priorPlan}
              </>
            ) : record ? (
              <PlanDocument
                record={record}
                selectedNodeId={selectedNodeId}
                onSelectNode={selectNode}
                onRenamePlan={renamePlan}
                onMoveNode={moveNode}
              />
            ) : (
              <div className="empty-document">
                <div className="empty-sheet" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <h3>还没有任务计划书</h3>
                <p>粘贴任务原文并生成后，阶段、任务、里程碑和验收标准会出现在这里。</p>
                <span className="empty-caption">从左侧开始</span>
              </div>
            )}
          </div>
        </section>

        <aside className="panel inspector-panel" aria-labelledby="inspector-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">检查器</p>
              <h2 id="inspector-title">任务详情</h2>
            </div>
          </div>

          <Inspector />
        </aside>
      </main>

      <footer className="app-footer">
        <span>本地运行</span>
        <span className="footer-separator" aria-hidden="true">
          ·
        </span>
        <span>数据只保存在这台机器</span>
        <span className="footer-version">v0.1</span>
      </footer>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
