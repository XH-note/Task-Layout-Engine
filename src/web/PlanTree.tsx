import {
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';

import {
  computeNodeNumbers,
  isGroup,
  movePlanNode,
  resolveDependencyNumbers,
  type PlanDropTarget,
  type PlanNode,
} from '../shared/plan';
import { computeStageSummary, formatHours } from '../shared/summary';

interface PlanTreeProps {
  nodes: PlanNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMoveNode: (draggedId: string, target: PlanDropTarget) => void;
}

interface DragHandlers {
  dragId: string | null;
  dropClassForNode: (id: string) => string;
  beginDrag: (id: string, event: DragEvent<HTMLElement>) => void;
  endDrag: () => void;
  handleDragOver: (id: string, event: DragEvent<HTMLElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLElement>) => void;
  handleDrop: (id: string, event: DragEvent<HTMLElement>) => void;
}

function activateOnKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onActivate: () => void,
) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onActivate();
  }
}

function dropPosition(event: DragEvent<HTMLElement>): 'before' | 'after' {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

function isAllowedMove(
  nodes: PlanNode[],
  draggedId: string,
  target: PlanDropTarget,
): boolean {
  const result = movePlanNode(nodes, draggedId, target);
  return result.moved || result.reason === undefined;
}

function PlanBranch({
  node,
  numbers,
  selectedId,
  onSelect,
  drag,
}: {
  node: PlanNode;
  numbers: Map<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  drag: DragHandlers;
}) {
  const children = node.children ?? [];
  const group = isGroup(node);
  const number = numbers.get(node.id) ?? '';
  const dependencies = resolveDependencyNumbers(node.deps, numbers);
  const selected = selectedId === node.id;

  return (
    <li className={group ? 'plan-branch' : 'plan-leaf'}>
      <div
        className={[
          'plan-row',
          selected ? 'selected' : '',
          drag.dragId === node.id ? 'dragging' : '',
          drag.dropClassForNode(node.id),
        ]
          .filter(Boolean)
          .join(' ')}
        role="button"
        tabIndex={0}
        draggable
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(node.id)}
        onKeyDown={(event) => activateOnKeyDown(event, () => onSelect(node.id))}
        onDragStart={(event) => drag.beginDrag(node.id, event)}
        onDragEnd={drag.endDrag}
        onDragOver={(event) => drag.handleDragOver(node.id, event)}
        onDragLeave={drag.handleDragLeave}
        onDrop={(event) => drag.handleDrop(node.id, event)}
      >
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
            <PlanBranch
              key={child.id}
              node={child}
              numbers={numbers}
              selectedId={selectedId}
              onSelect={onSelect}
              drag={drag}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function PlanTree({
  nodes,
  selectedId,
  onSelect,
  onMoveNode,
}: PlanTreeProps) {
  const numbers = computeNodeNumbers(nodes);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<PlanDropTarget | null>(null);
  const isStageDrag =
    dragId !== null && nodes.some((node) => node.id === dragId);

  const endDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };

  const beginDrag = (id: string, event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    setDragId(id);
    setDropTarget(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };

  const dropClassForNode = (id: string): string => {
    if (!dragId || !dropTarget || dropTarget.kind !== 'sibling') return '';
    if (dropTarget.nodeId !== id) return '';

    const result = movePlanNode(nodes, dragId, dropTarget);
    if (!result.moved && result.reason === undefined) return '';
    return `drop-${dropTarget.position}${result.moved ? '' : ' drop-invalid'}`;
  };

  const stageDropClass = (id: string): string => {
    if (
      !dragId ||
      !dropTarget ||
      (dropTarget.kind !== 'stage-end' && dropTarget.kind !== 'stage-position') ||
      dropTarget.stageId !== id
    ) {
      return '';
    }

    const result = movePlanNode(nodes, dragId, dropTarget);
    if (!result.moved && result.reason === undefined) return '';
    const position =
      dropTarget.kind === 'stage-position' ? ` drop-${dropTarget.position}` : '';
    return `drop-stage${position}${result.moved ? '' : ' drop-invalid'}`;
  };

  const buildStageTarget = (
    stageId: string,
    event: DragEvent<HTMLElement>,
  ): PlanDropTarget =>
    isStageDrag
      ? {
          kind: 'stage-position',
          stageId,
          position: dropPosition(event),
        }
      : { kind: 'stage-end', stageId };

  const handleStageDragOver = (
    stageId: string,
    event: DragEvent<HTMLElement>,
  ) => {
    if (!dragId) return;

    event.preventDefault();
    event.stopPropagation();
    const target = buildStageTarget(stageId, event);
    setDropTarget(target);
    event.dataTransfer.dropEffect = isAllowedMove(nodes, dragId, target)
      ? 'move'
      : 'none';
  };

  const handleStageDrop = (
    stageId: string,
    event: DragEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (dragId) onMoveNode(dragId, buildStageTarget(stageId, event));
    endDrag();
  };

  const handleNodeDragOver = (id: string, event: DragEvent<HTMLElement>) => {
    if (!dragId) return;

    event.preventDefault();
    event.stopPropagation();
    const target: PlanDropTarget = {
      kind: 'sibling',
      nodeId: id,
      position: dropPosition(event),
    };
    setDropTarget(target);
    event.dataTransfer.dropEffect = isAllowedMove(nodes, dragId, target)
      ? 'move'
      : 'none';
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDropTarget(null);
  };

  const handleNodeDrop = (id: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (dragId) {
      onMoveNode(dragId, {
        kind: 'sibling',
        nodeId: id,
        position: dropPosition(event),
      });
    }
    endDrag();
  };

  const drag: DragHandlers = {
    dragId,
    dropClassForNode,
    beginDrag,
    endDrag,
    handleDragOver: handleNodeDragOver,
    handleDragLeave,
    handleDrop: handleNodeDrop,
  };

  return (
    <div className="plan-tree">
      {nodes.map((stage) => {
        const summary = computeStageSummary(stage);
        const selected = selectedId === stage.id;

        return (
          <section className="plan-stage" key={stage.id}>
            <header
              className={[
                'plan-stage-heading',
                selected ? 'selected' : '',
                dragId === stage.id ? 'dragging' : '',
                stageDropClass(stage.id),
              ]
                .filter(Boolean)
                .join(' ')}
              role="button"
              tabIndex={0}
              draggable
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(stage.id)}
              onKeyDown={(event) =>
                activateOnKeyDown(event, () => onSelect(stage.id))
              }
              onDragStart={(event) => beginDrag(stage.id, event)}
              onDragEnd={endDrag}
              onDragOver={(event) => handleStageDragOver(stage.id, event)}
              onDragLeave={handleDragLeave}
              onDrop={(event) => handleStageDrop(stage.id, event)}
            >
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
                <PlanBranch
                  key={child.id}
                  node={child}
                  numbers={numbers}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  drag={drag}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
