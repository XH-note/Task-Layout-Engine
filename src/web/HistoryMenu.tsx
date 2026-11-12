import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import type { PlanListItem } from '../shared/plan';
import { exportPlanArchive, importPlanArchive } from './api';
import { usePlanStore } from './plan-store';

// “接近”上限时提前提示：spec 的 300 条 / 30 MB 的 80%。
const HISTORY_WARNING_COUNT = 240;
const HISTORY_WARNING_BYTES = 24 * 1024 * 1024;

type ArchiveNotice = {
  kind: 'ok' | 'error';
  text: string;
  reasons?: string[];
};

function archiveFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  return `任务计划书备份-${date}.json`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function HistoryMenu() {
  const history = usePlanStore((state) => state.history);
  const usage = usePlanStore((state) => state.usage);
  const historyLoading = usePlanStore((state) => state.historyLoading);
  const historyError = usePlanStore((state) => state.historyError);
  const record = usePlanStore((state) => state.record);
  const saveState = usePlanStore((state) => state.saveState);
  const switchPlan = usePlanStore((state) => state.switchPlan);
  const refreshHistory = usePlanStore((state) => state.refreshHistory);
  const removePlan = usePlanStore((state) => state.removePlan);
  const clearHistory = usePlanStore((state) => state.clearHistory);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PlanListItem | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearText, setClearText] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<ArchiveNotice | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void refreshHistory();
  }, [open, refreshHistory]);

  useEffect(() => {
    if (!open) setArchiveNotice(null);
  }, [open]);

  const search = query.trim();
  const normalizedSearch = search.toLocaleLowerCase();
  const matches = search
    ? history.filter((item) =>
        item.title.toLocaleLowerCase().includes(normalizedSearch),
      )
    : history.slice(0, 3);
  const nearLimit =
    usage.count >= HISTORY_WARNING_COUNT || usage.bytes >= HISTORY_WARNING_BYTES;

  const handleSwitch = async (id: string) => {
    const switched = await switchPlan(id);
    if (!switched) return;

    setOpen(false);
    setQuery('');
  };

  const handleDelete = async () => {
    if (!pendingDelete || busy) return;

    setBusy(true);
    const removed = await removePlan(pendingDelete.id);
    setBusy(false);
    if (removed) setPendingDelete(null);
  };

  const handleClear = async () => {
    if (clearText !== '删除' || busy) return;

    setBusy(true);
    const cleared = await clearHistory();
    setBusy(false);

    if (cleared) {
      setClearOpen(false);
      setClearText('');
      setOpen(false);
    }
  };

  const handleExport = async () => {
    if (archiveBusy) return;

    setArchiveBusy(true);
    setArchiveNotice(null);

    try {
      const archive = await exportPlanArchive();
      const blob = new Blob([JSON.stringify(archive, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = archiveFileName();
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      setArchiveNotice({
        kind: 'ok',
        text: `已导出 ${archive.plans.length} 条计划。`,
      });
    } catch (error) {
      setArchiveNotice({
        kind: 'error',
        text: errorMessage(error, '导出失败。'),
      });
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file || archiveBusy) return;

    setArchiveBusy(true);
    setArchiveNotice(null);

    try {
      let payload: unknown;

      try {
        payload = JSON.parse(await file.text());
      } catch {
        setArchiveNotice({ kind: 'error', text: '文件不是有效的 JSON。' });
        return;
      }

      const result = await importPlanArchive(payload);
      await refreshHistory();

      const skippedText = result.skipped > 0 ? `，跳过 ${result.skipped} 条` : '';
      setArchiveNotice({
        kind: 'ok',
        text: `已导入 ${result.imported} 条计划${skippedText}。`,
        ...(result.skippedReasons.length > 0
          ? { reasons: result.skippedReasons }
          : {}),
      });
    } catch (error) {
      setArchiveNotice({
        kind: 'error',
        text: errorMessage(error, '导入失败。'),
      });
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="history-wrap" ref={wrapRef}>
      <button
        className="quiet-button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        历史 {usage.count}
        <span className="chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="history-menu" role="dialog" aria-label="历史记录">
          <div className="history-menu-heading">
            <strong>历史记录</strong>
            <span>
              {usage.count} 条 · {formatBytes(usage.bytes)}
            </span>
          </div>

          <input
            className="history-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按标题搜索"
            aria-label="按标题搜索历史记录"
          />

          {nearLimit ? (
            <p className="history-warning" role="status">
              记录较多，建议清理不再需要的计划。
            </p>
          ) : null}

          {historyError ? (
            <div className="history-error" role="alert">
              <span>{historyError}</span>
              <button
                className="ghost-button"
                type="button"
                onClick={() => void refreshHistory()}
                disabled={historyLoading}
              >
                重试
              </button>
            </div>
          ) : null}

          {historyLoading && history.length === 0 ? (
            <p className="history-empty">正在读取历史记录…</p>
          ) : matches.length === 0 ? (
            <p className="history-empty">
              {search ? '没有匹配的计划书。' : '还没有历史记录。'}
            </p>
          ) : (
            <ul className="history-list">
              {matches.map((item) => {
                const current = record?.id === item.id;

                return (
                  <li className="history-item" key={item.id}>
                    <button
                      className={current ? 'history-item-main current' : 'history-item-main'}
                      type="button"
                      onClick={() => void handleSwitch(item.id)}
                      aria-current={current ? 'true' : undefined}
                    >
                      <span className="history-item-title">
                        {item.title}
                        {current ? <span className="history-current">当前</span> : null}
                      </span>
                      <span className="history-item-time">
                        {formatUpdatedAt(item.updatedAt)}
                      </span>
                    </button>
                    <button
                      className="history-delete"
                      type="button"
                      onClick={() => setPendingDelete(item)}
                      aria-label={`删除 ${item.title}`}
                    >
                      删除
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="history-archive">
            <button
              className="ghost-button"
              type="button"
              onClick={() => void handleExport()}
              disabled={archiveBusy || usage.count === 0}
            >
              导出全部 JSON
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={archiveBusy}
            >
              导入 JSON…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void handleImportFile(event)}
            />
          </div>

          {archiveNotice ? (
            <div
              className={
                archiveNotice.kind === 'error'
                  ? 'history-archive-status error'
                  : 'history-archive-status'
              }
              role={archiveNotice.kind === 'error' ? 'alert' : 'status'}
            >
              <span>{archiveNotice.text}</span>
              {archiveNotice.reasons && archiveNotice.reasons.length > 0 ? (
                <ul className="history-archive-reasons">
                  {archiveNotice.reasons.map((reason, index) => (
                    <li key={`${index}-${reason}`}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="history-menu-footer">
            <span className="history-caption">
              {search
                ? `共 ${matches.length} 条匹配结果`
                : history.length > 3
                  ? '最近 3 条；输入标题可搜索更早记录'
                  : '按更新时间倒序'}
            </span>
            <button
              className="history-clear"
              type="button"
              onClick={() => setClearOpen(true)}
              disabled={usage.count === 0}
            >
              清空全部…
            </button>
          </div>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="modal-backdrop">
          <div className="settings-dialog history-dialog" role="dialog" aria-modal="true">
            <div className="dialog-header">
              <div>
                <h2>删除这份计划书？</h2>
                <p className="dialog-subtitle">“{pendingDelete.title}”将从本机删除，无法恢复。</p>
                {pendingDelete.id === record?.id && saveState.status !== 'idle' ? (
                  <p className="history-warning" role="status">
                    当前计划还有未保存的修改，删除后会一并丢弃。
                  </p>
                ) : null}
              </div>
            </div>
            <div className="history-dialog-body">
              {historyError ? (
                <p className="history-error" role="alert">
                  {historyError}
                </p>
              ) : null}
            </div>
            <div className="dialog-actions">
              <span className="dialog-spacer" />
              <button
                className="secondary-button"
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={busy}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
              >
                {busy ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {clearOpen ? (
        <div className="modal-backdrop">
          <div className="settings-dialog history-dialog" role="dialog" aria-modal="true">
            <div className="dialog-header">
              <div>
                <h2>清空全部历史记录</h2>
                <p className="dialog-subtitle">
                  将删除本机保存的全部 {usage.count} 份计划书，无法恢复。
                </p>
              </div>
            </div>
            <div className="history-dialog-body">
              <label className="field">
                <span>输入“删除”以确认</span>
                <input
                  className="text-input"
                  type="text"
                  value={clearText}
                  onChange={(event) => setClearText(event.target.value)}
                  autoFocus
                />
              </label>
              {historyError ? (
                <p className="history-error" role="alert">
                  {historyError}
                </p>
              ) : null}
            </div>
            <div className="dialog-actions">
              <span className="dialog-spacer" />
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setClearOpen(false);
                  setClearText('');
                }}
                disabled={busy}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void handleClear()}
                disabled={busy || clearText !== '删除'}
              >
                {busy ? '清空中…' : '清空全部'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
