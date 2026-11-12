import { useState } from 'react';

import {
  collectLeafOptions,
  computeNodeNumbers,
  findPlanNode,
  findPlanNodePath,
  isGroup,
  MAX_TASK_DEPTH,
  removePlanNode,
  type PlanNode,
  type Priority,
} from '../shared/plan';
import { SAVE_DEBOUNCE_MS, usePlanStore } from './plan-store';

const PRIORITIES: Priority[] = ['P0', 'P1', 'P2'];

function EmptyInspector({ missing }: { missing?: boolean }) {
  return (
    <div className="empty-inspector">
      <div className="empty-inspector-mark" aria-hidden="true">
        ↖
      </div>
      <h3>{missing ? '该任务已不存在' : '选择一个任务'}</h3>
      <p>
        {missing
          ? '它可能已被删除，请从左侧重新选择。'
          : '生成计划书后，点击任务即可在这里编辑标题、工时、依赖和验收标准。'}
      </p>
    </div>
  );
}

export default function Inspector() {
  const record = usePlanStore((state) => state.record);
  const selectedNodeId = usePlanStore((state) => state.selectedNodeId);
  const updateNode = usePlanStore((state) => state.updateNode);
  const addChildNode = usePlanStore((state) => state.addChildNode);
  const deleteNode = usePlanStore((state) => state.deleteNode);
  const saveState = usePlanStore((state) => state.saveState);
  const editError = usePlanStore((state) => state.editError);
  const [pendingDelete, setPendingDelete] = useState<{
    nodeId: string;
    title: string;
    removedNodes: number;
    clearedDependencies: number;
    blocked: boolean;
  } | null>(null);

  if (!record || !selectedNodeId) {
    return <EmptyInspector />;
  }

  const node = findPlanNode(record.plan.nodes, selectedNodeId);
  if (!node) {
    return <EmptyInspector missing />;
  }

  const path = findPlanNodePath(record.plan.nodes, selectedNodeId) ?? [];
  const stage = path.length === 1;
  const leaf = !isGroup(node);
  const number = computeNodeNumbers(record.plan.nodes).get(node.id) ?? '';
  const leafOptions = leaf ? collectLeafOptions(record.plan.nodes) : [];
  const leafById = new Map(leafOptions.map((option) => [option.id, option]));
  const dependencies = node.deps ?? [];
  const availableDependencies = leafOptions.filter(
    (option) => option.id !== node.id && !dependencies.includes(option.id),
  );
  const error =
    editError ??
    (saveState.status === 'error' || saveState.status === 'invalid'
      ? saveState.message
      : null);

  const patch = (value: Partial<PlanNode>) => updateNode(node.id, value);
  const canAddChild = !leaf && path.length < MAX_TASK_DEPTH;

  const requestDelete = () => {
    const preview = removePlanNode(record.plan.nodes, node.id);

    setPendingDelete({
      nodeId: node.id,
      title: node.title,
      removedNodes: preview.removedNodeIds.length,
      clearedDependencies: preview.clearedDependencies,
      blocked: preview.nodes.length === 0,
    });
  };

  const confirmDelete = () => {
    if (!pendingDelete || pendingDelete.blocked) return;
    deleteNode(pendingDelete.nodeId);
    setPendingDelete(null);
  };

  return (
    <div className="inspector-form">
      <div className="inspector-node-heading">
        <span className="plan-number">{number}</span>
        <div>
          <p className="inspector-node-title">{node.title || '未命名节点'}</p>
          <p className="inspector-node-kind">
            {stage ? '阶段' : leaf ? '叶子任务' : '任务分组'}
          </p>
        </div>
      </div>

      {error ? (
        <p className="inspector-error" role="alert">
          {error}
        </p>
      ) : null}

      <label className="field">
        <span className="field-label">标题</span>
        <input
          className="text-input"
          value={node.title}
          readOnly={stage}
          onChange={(event) => patch({ title: event.target.value })}
        />
        {stage ? (
          <span className="field-hint">阶段标题暂不可修改。</span>
        ) : null}
      </label>

      <label className="field">
        <span className="field-label">说明</span>
        <textarea
          className="inspector-textarea"
          rows={3}
          value={node.desc ?? ''}
          onChange={(event) =>
            patch({ desc: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </label>

      {leaf ? (
        <>
          <div className="inspector-grid">
            <label className="field">
              <span className="field-label">优先级</span>
              <select
                className="select-input"
                value={node.priority ?? ''}
                onChange={(event) => {
                  patch({ priority: event.target.value as Priority });
                }}
              >
                {node.priority ? null : (
                  <option value="" disabled>
                    未设置
                  </option>
                )}
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">工时（小时）</span>
              <input
                className="text-input"
                type="number"
                min={0.5}
                max={8}
                step={0.5}
                value={node.estimateHours ?? ''}
                onChange={(event) =>
                  patch({
                    estimateHours:
                      event.target.value === ''
                        ? undefined
                        : Number(event.target.value),
                  })
                }
              />
            </label>
          </div>

          <label className="field">
            <span className="field-label">验收标准</span>
            <textarea
              className="inspector-textarea"
              rows={3}
              value={node.acceptance ?? ''}
              onChange={(event) =>
                patch({
                  acceptance:
                    event.target.value === '' ? undefined : event.target.value,
                })
              }
            />
          </label>

          <div className="field">
            <span className="field-label">依赖</span>
            <div className="dependency-list">
              {dependencies.length === 0 ? (
                <span className="dependency-empty">暂无依赖</span>
              ) : (
                dependencies.map((dependencyId) => {
                  const option = leafById.get(dependencyId);
                  const label = option
                    ? option.path
                    : `未知依赖（${dependencyId}）`;

                  return (
                    <span className="dependency-chip" key={dependencyId}>
                      <span>{label}</span>
                      <button
                        className="dependency-remove"
                        type="button"
                        aria-label={`移除依赖 ${label}`}
                        onClick={() =>
                          patch({
                            deps: dependencies.filter(
                              (id) => id !== dependencyId,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </span>
                  );
                })
              )}
            </div>
            <select
              className="select-input"
              value=""
              onChange={(event) => {
                const dependencyId = event.target.value;
                if (!dependencyId) return;
                patch({ deps: [...dependencies, dependencyId] });
              }}
            >
              <option value="">添加依赖…</option>
              {availableDependencies.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.number} {option.path}
                </option>
              ))}
            </select>
            <span className="field-hint">
              依赖只能指向现存叶子任务，不能自引或成环。
            </span>
          </div>
        </>
      ) : (
        <p className="field-hint">
          分组节点可修改标题和说明，也可以在下方新增叶子任务。
        </p>
      )}

      <div className="inspector-actions">
        {canAddChild ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => addChildNode(node.id)}
          >
            加叶子任务
          </button>
        ) : null}
        <button className="danger-button" type="button" onClick={requestDelete}>
          删除
        </button>
      </div>

      <p className="inspector-hint">
        修改会在停止输入 {SAVE_DEBOUNCE_MS / 1000} 秒后自动保存。
      </p>

      {pendingDelete ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingDelete(null);
          }}
        >
          <div
            className="settings-dialog inspector-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="inspector-delete-title"
          >
            <h2 id="inspector-delete-title">
              删除“{pendingDelete.title || '未命名节点'}”？
            </h2>
            {pendingDelete.blocked ? (
              <p className="inspector-error" role="alert">
                计划至少需要一个阶段，无法删除最后一个阶段。
              </p>
            ) : (
              <>
                <p>
                  {pendingDelete.removedNodes > 1 ? (
                    <>
                      将连带删除{' '}
                      <strong>{pendingDelete.removedNodes}</strong> 个节点。
                    </>
                  ) : (
                    '将删除这个任务节点。'
                  )}
                </p>
                <p>
                  {pendingDelete.clearedDependencies > 0
                    ? `另有 ${pendingDelete.clearedDependencies} 条依赖引用会被移除。`
                    : '没有其他任务依赖它。'}
                </p>
              </>
            )}
            <div className="inspector-delete-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setPendingDelete(null)}
              >
                {pendingDelete.blocked ? '关闭' : '取消'}
              </button>
              {pendingDelete.blocked ? null : (
                <button
                  className="danger-button"
                  type="button"
                  onClick={confirmDelete}
                >
                  删除
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
