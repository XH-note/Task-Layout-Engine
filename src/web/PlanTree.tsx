import {
  computeNodeNumbers,
  isGroup,
  resolveDependencyNumbers,
  type PlanNode,
} from '../shared/plan';
import { computeStageSummary, formatHours } from '../shared/summary';

interface PlanTreeProps {
  nodes: PlanNode[];
}

function PlanBranch({
  node,
  numbers,
}: {
  node: PlanNode;
  numbers: Map<string, string>;
}) {
  const children = node.children ?? [];
  const group = isGroup(node);
  const number = numbers.get(node.id) ?? '';
  const dependencies = resolveDependencyNumbers(node.deps, numbers);

  return (
    <li className={group ? 'plan-branch' : 'plan-leaf'}>
      <div className="plan-row">
        <span className="plan-number">{number}</span>
        <div className="plan-node-body">
          <div className="plan-node-heading">
            <span className="plan-node-title">{node.title}</span>
            {group ? null : (
              <span className="plan-node-badges">
                {node.priority ? (
                  <span
                    className={`plan-priority plan-priority-${node.priority.toLowerCase()}`}
                  >
                    {node.priority}
                  </span>
                ) : null}
                {node.estimateHours !== undefined ? (
                  <span className="plan-hours">
                    {formatHours(node.estimateHours)}
                  </span>
                ) : null}
              </span>
            )}
          </div>
          {group ? null : (
            <p className="plan-deps">
              {dependencies.length > 0
                ? `依赖 ${dependencies.join('、')}`
                : '无依赖'}
            </p>
          )}
          {node.desc ? <p className="plan-desc">{node.desc}</p> : null}
          {node.acceptance ? (
            <p className="plan-acceptance">
              <span className="plan-field-label">验收标准</span>
              {node.acceptance}
            </p>
          ) : null}
        </div>
      </div>
      {group ? (
        <ul className="plan-children">
          {children.map((child) => (
            <PlanBranch key={child.id} node={child} numbers={numbers} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function PlanTree({ nodes }: PlanTreeProps) {
  const numbers = computeNodeNumbers(nodes);

  return (
    <div className="plan-tree">
      {nodes.map((stage) => {
        const summary = computeStageSummary(stage);

        return (
          <section className="plan-stage" key={stage.id}>
            <header className="plan-stage-heading">
              <span className="plan-number plan-stage-number">
                {numbers.get(stage.id)}
              </span>
              <h5>{stage.title}</h5>
              <span className="plan-stage-summary">
                {summary.taskCount} 个任务 · 合计{' '}
                {formatHours(summary.totalHours)}
              </span>
            </header>
            <ul className="plan-stage-list">
              {(stage.children ?? []).map((child) => (
                <PlanBranch key={child.id} node={child} numbers={numbers} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
