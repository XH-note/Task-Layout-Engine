import { collectLeaves, computeNodeNumbers, type PlanNode } from '../shared/plan';

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
  const number = numbers.get(node.id) ?? '';

  return (
    <li className={children.length > 0 ? 'plan-branch' : 'plan-leaf'}>
      <div className="plan-row">
        <span className="plan-number">{number}</span>
        <span className="plan-node-title">{node.title}</span>
      </div>
      {children.length > 0 ? (
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
        const children = stage.children ?? [];

        return (
          <section className="plan-stage" key={stage.id}>
            <header className="plan-stage-heading">
              <span className="plan-number plan-stage-number">
                {numbers.get(stage.id)}
              </span>
              <h4>{stage.title}</h4>
              <span className="plan-stage-count">
                {collectLeaves(children).length} 个叶子任务
              </span>
            </header>
            <ul className="plan-stage-list">
              {children.map((child) => (
                <PlanBranch key={child.id} node={child} numbers={numbers} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
