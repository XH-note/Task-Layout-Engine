import { useEffect, useRef, useState } from 'react';

import { planMarkdownFileName, renderPlanMarkdown } from '../shared/markdown';
import type { PlanRecord } from '../shared/plan';

export type PrintLayout = 'document' | 'overview';

/** 叶子任务超过该数量时才提供“一页总览”版式。 */
export const OVERVIEW_MIN_LEAVES = 12;

function downloadMarkdown(record: PlanRecord): void {
  const blob = new Blob([renderPlanMarkdown(record)], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = planMarkdownFileName(record.title);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function ExportMenu({
  record,
  leafCount,
  layout,
  onLayoutChange,
  onPrint,
}: {
  record: PlanRecord | null;
  leafCount: number;
  layout: PrintLayout;
  onLayoutChange: (layout: PrintLayout) => void;
  onPrint: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canOverview = leafCount > OVERVIEW_MIN_LEAVES;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (wrapRef.current && event.target instanceof Node && wrapRef.current.contains(event.target)) {
        return;
      }
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
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 3000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const handleMarkdown = () => {
    if (!record) return;

    downloadMarkdown(record);
    setStatus('Markdown 已下载。');
    setOpen(false);
  };

  const handlePrint = () => {
    if (!record) return;

    setOpen(false);
    onPrint();
  };

  return (
    <div className="export-wrap" ref={wrapRef}>
      <button
        className="export-button"
        type="button"
        aria-expanded={open}
        aria-controls="export-menu"
        disabled={!record}
        title={record ? '导出当前计划书' : '生成计划书后可导出'}
        onClick={() => setOpen((value) => !value)}
      >
        导出 ▾
      </button>

      {open && record ? (
        <div className="export-menu" id="export-menu" role="group" aria-label="导出">
          <p className="export-menu-heading">导出当前计划书</p>

          <button className="export-action" type="button" onClick={handleMarkdown}>
            <span>下载 Markdown</span>
            <small>GFM · 与页面同源</small>
          </button>

          <div className="export-divider" />

          <p className="export-menu-heading">打印版式</p>
          <label className="export-option">
            <input
              type="radio"
              name="print-layout"
              checked={layout === 'document'}
              onChange={() => onLayoutChange('document')}
            />
            <span>
              文档式
              <small>完整任务树、里程碑与验收</small>
            </span>
          </label>
          <label className={canOverview ? 'export-option' : 'export-option disabled'}>
            <input
              type="radio"
              name="print-layout"
              checked={layout === 'overview'}
              disabled={!canOverview}
              onChange={() => onLayoutChange('overview')}
            />
            <span>
              一页总览
              <small>
                {canOverview ? '第一页附叶子任务总表' : `叶子任务超过 ${OVERVIEW_MIN_LEAVES} 个时可用`}
              </small>
            </span>
          </label>

          <button className="primary-button export-print" type="button" onClick={handlePrint}>
            打印 / 另存为 PDF
          </button>
          <p className="export-hint">
            打印对话框中选择“另存为 PDF”，关闭浏览器页眉页脚，并勾选“背景图形”。
          </p>
        </div>
      ) : null}

      {status ? (
        <span className="export-status" role="status">
          {status}
        </span>
      ) : null}
    </div>
  );
}
