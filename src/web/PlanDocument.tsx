import type { ReactNode } from 'react';

import type { PlanRecord } from '../shared/plan';
import {
  computePlanSummary,
  formatGeneratedAt,
  formatHours,
  formatWeek,
  formatWeekRange,
} from '../shared/summary';
import PlanTree from './PlanTree';

function PlanSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="plan-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function PlanList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) {
    return <p className="plan-empty">{empty}</p>;
  }

  return (
    <ul className="plan-list">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

export default function PlanDocument({ record }: { record: PlanRecord }) {
  const { plan } = record;
  const summary = computePlanSummary(plan);

  return (
    <article className="plan-document">
      <header className="plan-document-heading">
        <p className="eyebrow">任务计划书</p>
        <h3>{record.title}</h3>
        <dl className="plan-meta">
          <div>
            <dt>阶段数</dt>
            <dd>{summary.stageCount}</dd>
          </div>
          <div>
            <dt>叶子任务</dt>
            <dd>{summary.leafCount}</dd>
          </div>
          <div>
            <dt>总工时</dt>
            <dd>{formatHours(summary.totalHours)}</dd>
          </div>
          <div>
            <dt>周期</dt>
            <dd title="按已知任务周次与里程碑周次汇总">
              {formatWeekRange(summary.weekRange)}
            </dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{formatGeneratedAt(plan.meta.generatedAt)}</dd>
          </div>
        </dl>
      </header>

      <PlanSection title="目标">
        <p>{plan.goal || '未填写目标。'}</p>
      </PlanSection>

      <PlanSection title="背景">
        <p>{plan.background || '未填写背景。'}</p>
      </PlanSection>

      <PlanSection title="任务分解">
        <PlanTree nodes={plan.nodes} />
      </PlanSection>

      <PlanSection title="里程碑">
        {plan.milestones.length > 0 ? (
          <table className="plan-table">
            <thead>
              <tr>
                <th scope="col">编号</th>
                <th scope="col">名称</th>
                <th scope="col">周次</th>
              </tr>
            </thead>
            <tbody>
              {plan.milestones.map((milestone, index) => (
                <tr key={`${index}-${milestone.name}`}>
                  <td className="plan-table-number">M{index + 1}</td>
                  <td>{milestone.name}</td>
                  <td className="plan-table-week">
                    {formatWeek(milestone.week)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="plan-empty">暂无里程碑。</p>
        )}
      </PlanSection>

      <PlanSection title="风险与假设">
        <PlanList items={plan.risks} empty="暂无风险与假设。" />
      </PlanSection>

      <PlanSection title="计划级验收">
        <PlanList items={plan.acceptance} empty="暂无计划级验收。" />
      </PlanSection>
    </article>
  );
}
