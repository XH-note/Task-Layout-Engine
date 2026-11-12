import { renderPlanLeafRows, type PlanLeafRow } from '../shared/markdown';
import type { PlanRecord } from '../shared/plan';
import {
  computePlanSummary,
  formatHours,
  formatWeekRange,
} from '../shared/summary';

export default function PlanOverview({ record }: { record: PlanRecord }) {
  const summary = computePlanSummary(record.plan);
  const rows = renderPlanLeafRows(record.plan);
  const stages: Array<{ id: string; title: string; rows: PlanLeafRow[] }> = [];

  for (const row of rows) {
    const stage = stages[stages.length - 1];
    if (stage?.id === row.stageId) {
      stage.rows.push(row);
    } else {
      stages.push({ id: row.stageId, title: row.stageTitle, rows: [row] });
    }
  }

  return (
    <section className="print-overview" aria-label="一页总览">
      <header className="print-overview-heading">
        <p className="eyebrow">一页总览</p>
        <h2>{record.title}</h2>
        <p>
          {summary.stageCount} 个阶段 · {summary.leafCount} 个叶子任务 · 合计{' '}
          {formatHours(summary.totalHours)}
          {summary.weekRange
            ? ` · ${formatWeekRange(summary.weekRange)}`
            : ' · 未指定周次，按阶段分组'}
        </p>
      </header>

      <table className="print-overview-table">
        <thead>
          <tr>
            <th scope="col">编号</th>
            <th scope="col">任务</th>
            <th scope="col">优先级</th>
            <th scope="col">工时</th>
            <th scope="col">依赖</th>
          </tr>
        </thead>
        {stages.map((stage) => (
          <tbody key={stage.id}>
            <tr className="print-overview-stage">
              <th scope="rowgroup" colSpan={5}>
                {stage.title}
              </th>
            </tr>
            {stage.rows.map((row) => (
              <tr key={row.node.id}>
                <td className="print-overview-number">{row.number}</td>
                <td>{row.node.title}</td>
                <td>{row.node.priority ?? '—'}</td>
                <td className="print-overview-hours">
                  {row.node.estimateHours === undefined
                    ? '—'
                    : formatHours(row.node.estimateHours)}
                </td>
                <td>{row.dependencies}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>

      <p className="print-overview-note">
        总览只列叶子任务；详细说明与验收标准见后续页面。
      </p>
    </section>
  );
}
