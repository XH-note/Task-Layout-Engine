import { useEffect, useRef, useState } from 'react';

import { MAX_SOURCE_CODE_POINTS, getSourceState } from '../shared/source';
import SettingsDialog from './SettingsDialog';
import { useWorkbenchStore } from './store';

export default function App() {
  const source = useWorkbenchStore((state) => state.source);
  const setSource = useWorkbenchStore((state) => state.setSource);
  const clearSource = useWorkbenchStore((state) => state.clearSource);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sourceState = getSourceState(source);

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
    clearSource();
    textareaRef.current?.focus();
  };

  const remaining = MAX_SOURCE_CODE_POINTS - sourceState.codePoints;
  const helperText = sourceState.overLimit
    ? `原文超出上限 ${Math.abs(remaining).toLocaleString('zh-CN')} 个字符，请删减后再生成。`
    : sourceState.empty
      ? '先粘贴任务原文；生成能力将在下一步接入。'
      : '输入已就绪；生成能力将在下一步接入。';

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
          <button className="quiet-button" type="button" disabled title="历史记录将在后续切片接入">
            历史记录
            <span className="chevron" aria-hidden="true">
              ▾
            </span>
          </button>
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
            <p className={sourceState.overLimit ? 'helper-text warning' : 'helper-text'}>{helperText}</p>
            <button className="generate-button" type="button" disabled title="生成能力将在下一步接入">
              生成任务计划书
            </button>
          </div>
        </section>

        <section className="panel document-panel" aria-labelledby="document-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">任务计划书</p>
              <h2 id="document-title">阅读视图</h2>
            </div>
            <span className="status-pill">尚未生成</span>
          </div>

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
        </section>

        <aside className="panel inspector-panel" aria-labelledby="inspector-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">检查器</p>
              <h2 id="inspector-title">任务详情</h2>
            </div>
          </div>

          <div className="empty-inspector">
            <div className="empty-inspector-mark" aria-hidden="true">
              ↖
            </div>
            <h3>选择一个任务</h3>
            <p>生成计划书后，点击任务即可在这里编辑标题、工时、依赖和验收标准。</p>
          </div>
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
