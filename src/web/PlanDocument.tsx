import { collectLeaves, type PlanRecord } from '../shared/plan';
import PlanTree from './PlanTree';

export default function PlanDocument({ record }: { record: PlanRecord }) {
  const leaves = collectLeaves(record.plan.nodes);

  return (
    <article className="plan-document">
      <header className="plan-document-heading">
        <p className="eyebrow">任务计划书</p>
        <h3>{record.title}</h3>
        <p className="plan-summary">
          {record.plan.nodes.length} 个阶段 · {leaves.length} 个叶子任务
        </p>
      </header>
      <PlanTree nodes={record.plan.nodes} />
    </article>
  );
}
