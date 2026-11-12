import type { WireNode, WirePlan } from './wire';

export type Priority = 'P0' | 'P1' | 'P2';

export const MAX_TASK_DEPTH = 3;

export interface PlanNode {
  id: string;
  title: string;
  desc?: string;
  children?: PlanNode[];
  priority?: Priority;
  estimateHours?: number;
  deps?: string[];
  acceptance?: string;
  startWeek?: number;
  endWeek?: number;
}

export interface Plan {
  title: string;
  goal: string;
  background: string;
  risks: string[];
  milestones: { name: string; week?: number }[];
  acceptance: string[];
  nodes: PlanNode[];
  meta: {
    generatedAt: string;
    source: string;
    model: string;
    version: string;
  };
}

export interface PlanRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  plan: Plan;
  source: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  raw?: unknown;
}

export interface PlanListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanHistoryUsage {
  count: number;
  bytes: number;
}

export interface PlanListResponse {
  plans: PlanListItem[];
  usage: PlanHistoryUsage;
}

export interface RegenerateLeafResponse {
  record: PlanRecord;
  warning?: string;
}

export function comparePlansByUpdatedAt(
  a: { updatedAt: string },
  b: { updatedAt: string },
): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function toPlanListItem(record: PlanRecord): PlanListItem {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface PlanIssue {
  path: string;
  message: string;
}

export interface LeafOption {
  id: string;
  title: string;
  path: string;
  number: string;
}

export interface NormalizeWireOptions {
  createId?: () => string;
  generatedAt?: string;
  source?: string;
  model?: string;
  version?: string;
}

export interface NormalizeWireResult {
  plan: Plan;
  issues: PlanIssue[];
}

export interface ValidatePlanOptions {
  requireGeneratedShape?: boolean;
}

function defaultNodeId(): string {
  return globalThis.crypto.randomUUID();
}

function cleanList(items: string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

export function isGroup(node: PlanNode): boolean {
  return (node.children?.length ?? 0) > 0;
}

export function normalizeWirePlan(
  wire: WirePlan,
  options: NormalizeWireOptions = {},
): NormalizeWireResult {
  const createId = options.createId ?? defaultNodeId;
  const issues: PlanIssue[] = [];
  const idByKey = new Map<string, string>();
  const dependencyEntries: { node: PlanNode; path: string; keys: string[] }[] = [];

  const walk = (wireNodes: WireNode[], parentPath: string): PlanNode[] =>
    wireNodes.map((wireNode, index) => {
      const path = parentPath ? `${parentPath}.children[${index}]` : `nodes[${index}]`;

      if (idByKey.has(wireNode.key)) {
        issues.push({
          path: `${path}.key`,
          message: `临时 key 重复：${wireNode.key}。`,
        });
      } else {
        idByKey.set(wireNode.key, createId());
      }

      const node: PlanNode = {
        id: idByKey.get(wireNode.key) as string,
        title: wireNode.title.trim(),
      };

      if (wireNode.desc.trim()) node.desc = wireNode.desc.trim();

      if (wireNode.children.length > 0) {
        node.children = walk(wireNode.children, path);
      } else {
        if (wireNode.priority !== '') node.priority = wireNode.priority;
        node.estimateHours = wireNode.estimateHours;
        node.acceptance = wireNode.acceptance.trim();
        dependencyEntries.push({ node, path, keys: wireNode.deps });
      }

      return node;
    });

  const nodes = walk(wire.nodes, '');

  for (const entry of dependencyEntries) {
    const resolved: string[] = [];

    entry.keys.forEach((key, index) => {
      const dependencyId = idByKey.get(key);

      if (!dependencyId) {
        issues.push({
          path: `${entry.path}.deps[${index}]`,
          message: `依赖指向不存在的任务：${key}。`,
        });
        return;
      }

      resolved.push(dependencyId);
    });

    if (resolved.length > 0) entry.node.deps = resolved;
  }

  const milestones = wire.milestones
    .map((milestone) => {
      const name = milestone.name.trim();
      const week = /^W(\d+)$/.exec(milestone.week);
      return { name, ...(week ? { week: Number(week[1]) } : {}) };
    })
    .filter((milestone) => milestone.name.length > 0);

  const plan: Plan = {
    title: wire.title.trim(),
    goal: wire.goal.trim(),
    background: wire.background.trim(),
    risks: cleanList(wire.risks),
    milestones,
    acceptance: cleanList(wire.acceptance),
    nodes,
    meta: {
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      source: options.source ?? 'paste',
      model: options.model ?? '',
      version: options.version ?? '1',
    },
  };

  return { plan, issues };
}

export function validatePlan(
  plan: Plan,
  options: ValidatePlanOptions = {},
): PlanIssue[] {
  const issues: PlanIssue[] = [];

  if (!plan.title.trim()) {
    issues.push({ path: 'title', message: '计划标题不能为空。' });
  }

  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    issues.push({ path: 'nodes', message: '计划至少需要一个阶段。' });
    return issues;
  }

  const nodeById = new Map<string, { node: PlanNode; path: string; leaf: boolean }>();
  const leaves: { node: PlanNode; path: string }[] = [];

  const walk = (nodes: PlanNode[], parentPath: string, depth: number) => {
    nodes.forEach((node, index) => {
      const path = parentPath ? `${parentPath}.children[${index}]` : `nodes[${index}]`;

      if (depth > MAX_TASK_DEPTH) {
        issues.push({
          path,
          message: `任务层级最多 ${MAX_TASK_DEPTH} 层（阶段 → 任务 → 子任务）。`,
        });
        return;
      }

      if (!node.title.trim()) {
        issues.push({ path: `${path}.title`, message: '节点标题不能为空。' });
      }

      if (nodeById.has(node.id)) {
        issues.push({ path: `${path}.id`, message: `节点 id 重复：${node.id}。` });
      }

      const leaf = !isGroup(node);
      nodeById.set(node.id, { node, path, leaf });

      if (leaf) {
        leaves.push({ node, path });

        if (!node.priority) {
          issues.push({
            path: `${path}.priority`,
            message: '叶子任务必须填写优先级 P0/P1/P2。',
          });
        }

        if (
          node.estimateHours === undefined ||
          !Number.isFinite(node.estimateHours) ||
          node.estimateHours < 0.5 ||
          node.estimateHours > 8
        ) {
          issues.push({
            path: `${path}.estimateHours`,
            message: '叶子任务工时必须在 0.5–8 小时之间。',
          });
        }

        if (!node.acceptance || !node.acceptance.trim()) {
          issues.push({
            path: `${path}.acceptance`,
            message: '叶子任务必须填写验收标准。',
          });
        }

        if (node.deps?.includes(node.id)) {
          issues.push({
            path: `${path}.deps`,
            message: '任务不能依赖自身。',
          });
        }
      } else {
        if (node.priority !== undefined) {
          issues.push({
            path: `${path}.priority`,
            message: '分组节点不能设置优先级。',
          });
        }
        if (node.estimateHours !== undefined) {
          issues.push({
            path: `${path}.estimateHours`,
            message: '分组节点不能设置工时。',
          });
        }
        if (node.deps !== undefined) {
          issues.push({
            path: `${path}.deps`,
            message: '分组节点不能有依赖。',
          });
        }
        if (node.acceptance !== undefined) {
          issues.push({
            path: `${path}.acceptance`,
            message: '分组节点不能设置验收标准。',
          });
        }

        walk(node.children ?? [], path, depth + 1);
      }
    });
  };

  walk(plan.nodes, '', 1);

  plan.nodes.forEach((node, index) => {
    if (!isGroup(node)) {
      issues.push({
        path: `nodes[${index}]`,
        message: '阶段必须包含任务，不能直接是叶子任务。',
      });
    }
  });

  for (const { node, path } of leaves) {
    (node.deps ?? []).forEach((dependencyId, index) => {
      if (dependencyId === node.id) return;

      const target = nodeById.get(dependencyId);
      if (!target) {
        issues.push({
          path: `${path}.deps[${index}]`,
          message: `依赖指向不存在的任务：${dependencyId}。`,
        });
        return;
      }

      if (!target.leaf) {
        issues.push({
          path: `${path}.deps[${index}]`,
          message: `依赖只允许指向叶子任务：${dependencyId}。`,
        });
      }
    });
  }

  const leafIds = new Set(leaves.map((leaf) => leaf.node.id));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);

    for (const dependencyId of nodeById.get(id)?.node.deps ?? []) {
      if (!leafIds.has(dependencyId)) continue;

      const dependencyState = state.get(dependencyId) ?? 0;

      if (dependencyState === 1) {
        const cycleStart = stack.indexOf(dependencyId);
        const cycle = [...stack.slice(cycleStart), dependencyId];
        const label = cycle
          .map((cycleId) => nodeById.get(cycleId)?.node.title ?? cycleId)
          .join(' → ');
        const issuePath = `${nodeById.get(id)?.path}.deps`;

        if (!reportedCycles.has(issuePath)) {
          reportedCycles.add(issuePath);
          issues.push({
            path: issuePath,
            message: `依赖成环：${label}。`,
          });
        }
      } else if (dependencyState === 0) {
        visit(dependencyId);
      }
    }

    stack.pop();
    state.set(id, 2);
  };

  for (const leaf of leaves) {
    if (!state.get(leaf.node.id)) visit(leaf.node.id);
  }

  if (options.requireGeneratedShape) {
    if (plan.nodes.length < 2 || plan.nodes.length > 4) {
      issues.push({
        path: 'nodes',
        message: `生成结果需要 2–4 个阶段，当前 ${plan.nodes.length} 个。`,
      });
    }

    if (leaves.length < 12 || leaves.length > 20) {
      issues.push({
        path: 'nodes',
        message: `生成结果需要 12–20 个叶子任务，当前 ${leaves.length} 个。`,
      });
    }
  }

  return issues;
}

export function computeNodeNumbers(nodes: PlanNode[]): Map<string, string> {
  const numbers = new Map<string, string>();

  const walk = (list: PlanNode[], prefix: string) => {
    list.forEach((node, index) => {
      const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
      numbers.set(node.id, number);
      if (node.children && node.children.length > 0) {
        walk(node.children, number);
      }
    });
  };

  walk(nodes, '');
  return numbers;
}

export function collectLeaves(nodes: PlanNode[]): PlanNode[] {
  const leaves: PlanNode[] = [];

  const walk = (list: PlanNode[]) => {
    for (const node of list) {
      if (isGroup(node)) {
        walk(node.children ?? []);
      } else {
        leaves.push(node);
      }
    }
  };

  walk(nodes);
  return leaves;
}

export function resolveDependencyNumbers(
  deps: string[] | undefined,
  numbers: Map<string, string>,
): string[] {
  return (deps ?? []).map((id) => numbers.get(id) ?? '未知编号');
}

export function findPlanNode(
  nodes: PlanNode[],
  id: string,
): PlanNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findPlanNode(node.children ?? [], id);
    if (found) return found;
  }

  return undefined;
}

export function findPlanNodePath(
  nodes: PlanNode[],
  id: string,
): PlanNode[] | undefined {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const found = findPlanNodePath(node.children ?? [], id);
    if (found) return [node, ...found];
  }

  return undefined;
}

export function collectLeafOptions(nodes: PlanNode[]): LeafOption[] {
  const numbers = computeNodeNumbers(nodes);
  const options: LeafOption[] = [];

  const walk = (list: PlanNode[], trail: string[]) => {
    for (const node of list) {
      const nextTrail = [...trail, node.title];

      if (isGroup(node)) {
        walk(node.children ?? [], nextTrail);
      } else {
        options.push({
          id: node.id,
          title: node.title,
          path: nextTrail.join(' / '),
          number: numbers.get(node.id) ?? '',
        });
      }
    }
  };

  walk(nodes, []);
  return options;
}

export function collectSubtreeIds(nodes: PlanNode[], id: string): string[] {
  const node = findPlanNode(nodes, id);
  if (!node) return [];

  const ids: string[] = [];
  const walk = (current: PlanNode) => {
    ids.push(current.id);
    current.children?.forEach(walk);
  };

  walk(node);
  return ids;
}

export function countDependenciesTo(
  nodes: PlanNode[],
  targetIds: Iterable<string>,
): number {
  const targets = targetIds instanceof Set ? targetIds : new Set(targetIds);
  let count = 0;

  const walk = (list: PlanNode[]) => {
    for (const node of list) {
      if (!targets.has(node.id)) {
        for (const dependencyId of node.deps ?? []) {
          if (targets.has(dependencyId)) count += 1;
        }
      }
      if (node.children && node.children.length > 0) walk(node.children);
    }
  };

  walk(nodes);
  return count;
}

export function insertChildNode(
  nodes: PlanNode[],
  parentId: string,
  child: PlanNode,
): PlanNode[] {
  if (isGroup(child)) return nodes;

  const walk = (list: PlanNode[], depth: number): PlanNode[] => {
    let changed = false;
    const next = list.map((node) => {
      if (node.id === parentId) {
        if (depth >= MAX_TASK_DEPTH || (depth > 1 && !isGroup(node))) {
          return node;
        }

        changed = true;
        return { ...node, children: [...(node.children ?? []), child] };
      }

      if (node.children && node.children.length > 0) {
        const children = walk(node.children, depth + 1);
        if (children !== node.children) {
          changed = true;
          return { ...node, children };
        }
      }

      return node;
    });

    return changed ? next : list;
  };

  return walk(nodes, 1);
}

export type RemovePlanNodeResult = {
  nodes: PlanNode[];
  removedNodeIds: string[];
  clearedDependencies: number;
};

export function removePlanNode(
  nodes: PlanNode[],
  id: string,
): RemovePlanNodeResult {
  const subtreeIds = collectSubtreeIds(nodes, id);
  if (subtreeIds.length === 0) {
    return { nodes, removedNodeIds: [], clearedDependencies: 0 };
  }

  const removed = new Set(subtreeIds);

  const prune = (list: PlanNode[]): PlanNode[] => {
    let changed = false;
    const next: PlanNode[] = [];

    for (const node of list) {
      if (node.id === id) {
        changed = true;
        continue;
      }

      if (node.children && node.children.length > 0) {
        const children = prune(node.children);
        if (children !== node.children) {
          changed = true;
          if (children.length === 0) {
            removed.add(node.id);
            continue;
          }
          next.push({ ...node, children });
          continue;
        }
      }

      next.push(node);
    }

    return changed ? next : list;
  };

  const pruned = prune(nodes);
  const clearedDependencies = countDependenciesTo(pruned, removed);

  const clean = (list: PlanNode[]): PlanNode[] => {
    let changed = false;
    const next = list.map((node) => {
      let updated = node;

      if (node.deps && node.deps.some((dependencyId) => removed.has(dependencyId))) {
        const deps = node.deps.filter((dependencyId) => !removed.has(dependencyId));
        updated = { ...node, deps };
        if (deps.length === 0) delete updated.deps;
        changed = true;
      }

      if (node.children && node.children.length > 0) {
        const children = clean(node.children);
        if (children !== node.children) {
          updated = { ...(updated === node ? node : updated), children };
          changed = true;
        }
      }

      return updated;
    });

    return changed ? next : list;
  };

  return {
    nodes: clean(pruned),
    removedNodeIds: [...removed],
    clearedDependencies,
  };
}

export function createLeafDraft(id: string = defaultNodeId()): PlanNode {
  return {
    id,
    title: '新任务',
    desc: '补充任务说明。',
    priority: 'P2',
    estimateHours: 1,
    acceptance: '待补充验收标准。',
  };
}

export type PlanDropTarget =
  | { kind: 'stage-end'; stageId: string }
  | { kind: 'stage-position'; stageId: string; position: 'before' | 'after' }
  | { kind: 'sibling'; nodeId: string; position: 'before' | 'after' };

export interface MovePlanNodeResult {
  nodes: PlanNode[];
  moved: boolean;
  reason?: string;
}

function findParentId(
  nodes: PlanNode[],
  id: string,
  parentId: string | null = null,
): string | null | undefined {
  for (const node of nodes) {
    if (node.id === id) return parentId;

    if (node.children && node.children.length > 0) {
      const found = findParentId(node.children, id, node.id);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function extractPlanNode(
  nodes: PlanNode[],
  id: string,
): { nodes: PlanNode[]; node: PlanNode } | null {
  const walk = (list: PlanNode[]): PlanNode[] | null => {
    const index = list.findIndex((node) => node.id === id);
    if (index >= 0) return [...list.slice(0, index), ...list.slice(index + 1)];

    for (let position = 0; position < list.length; position += 1) {
      const node = list[position]!;
      if (!node.children || node.children.length === 0) continue;

      const children = walk(node.children);
      if (children) {
        return list.map((current, currentIndex) =>
          currentIndex === position ? { ...current, children } : current,
        );
      }
    }

    return null;
  };

  const node = findPlanNode(nodes, id);
  const extracted = node ? walk(nodes) : null;

  return node && extracted ? { nodes: extracted, node } : null;
}

function insertSiblingNode(
  nodes: PlanNode[],
  targetId: string,
  node: PlanNode,
  position: 'before' | 'after',
): PlanNode[] | null {
  const index = nodes.findIndex((current) => current.id === targetId);
  if (index >= 0) {
    const next = [...nodes];
    next.splice(index + (position === 'after' ? 1 : 0), 0, node);
    return next;
  }

  for (let positionIndex = 0; positionIndex < nodes.length; positionIndex += 1) {
    const current = nodes[positionIndex]!;
    if (!current.children || current.children.length === 0) continue;

    const children = insertSiblingNode(
      current.children,
      targetId,
      node,
      position,
    );
    if (children) {
      return nodes.map((candidate, candidateIndex) =>
        candidateIndex === positionIndex
          ? { ...candidate, children }
          : candidate,
      );
    }
  }

  return null;
}

function rejectedMove(nodes: PlanNode[], reason: string): MovePlanNodeResult {
  return { nodes, moved: false, reason };
}

export function movePlanNode(
  nodes: PlanNode[],
  draggedId: string,
  target: PlanDropTarget,
): MovePlanNodeResult {
  const dragged = findPlanNode(nodes, draggedId);
  if (!dragged) return rejectedMove(nodes, '找不到要移动的节点。');

  const isStage = nodes.some((node) => node.id === draggedId);

  if (isStage) {
    if (target.kind !== 'stage-position') {
      return rejectedMove(nodes, '阶段只能拖到另一个阶段头调整顺序。');
    }

    if (target.stageId === draggedId) return { nodes, moved: false };

    const from = nodes.findIndex((node) => node.id === draggedId);
    const to = nodes.findIndex((node) => node.id === target.stageId);
    if (from < 0 || to < 0) return rejectedMove(nodes, '找不到放置目标。');

    const without = nodes.filter((node) => node.id !== draggedId);
    let insertAt = to + (target.position === 'after' ? 1 : 0);
    if (from < insertAt) insertAt -= 1;
    if (insertAt === from) return { nodes, moved: false };

    const next = [...without];
    next.splice(insertAt, 0, dragged);
    return { nodes: next, moved: true };
  }

  if (target.kind === 'stage-position') {
    return rejectedMove(nodes, '只有阶段头可以拖动来调整阶段顺序。');
  }

  const sourceParent = findParentId(nodes, draggedId);
  if (sourceParent === undefined) return rejectedMove(nodes, '找不到任务所在的层级。');

  if (target.kind === 'stage-end') {
    const stage = nodes.find((node) => node.id === target.stageId);
    if (!stage) return rejectedMove(nodes, '找不到放置目标。');

    const children = stage.children ?? [];
    if (
      sourceParent === stage.id &&
      children[children.length - 1]?.id === draggedId
    ) {
      return { nodes, moved: false };
    }

    if (sourceParent !== null) {
      const parent = findPlanNode(nodes, sourceParent);
      if ((parent?.children ?? []).length === 1) {
        return rejectedMove(
          nodes,
          '移走后上级节点会变空，请先新增任务再移走。',
        );
      }
    }

    const extracted = extractPlanNode(nodes, draggedId);
    if (!extracted) return rejectedMove(nodes, '找不到要移动的节点。');

    const next = extracted.nodes.map((node) =>
      node.id === stage.id
        ? { ...node, children: [...(node.children ?? []), extracted.node] }
        : node,
    );

    return { nodes: next, moved: true };
  }

  if (target.nodeId === draggedId) return { nodes, moved: false };

  const targetPath = findPlanNodePath(nodes, target.nodeId);
  if (!targetPath) return rejectedMove(nodes, '找不到放置目标。');
  if (targetPath.some((node) => node.id === draggedId)) {
    return rejectedMove(nodes, '不能把任务拖进自己的子树。');
  }

  const targetParent = findParentId(nodes, target.nodeId);
  if (targetParent === undefined) return rejectedMove(nodes, '找不到放置目标。');

  if (sourceParent !== null) {
    const parent = findPlanNode(nodes, sourceParent);
    if ((parent?.children ?? []).length === 1) {
      return rejectedMove(
        nodes,
        '移走后上级节点会变空，请先新增任务再移走。',
      );
    }
  }

  const sourcePath = findPlanNodePath(nodes, draggedId) ?? [];
  const sameParent = sourceParent === targetParent;
  const sameDepthAcrossParents =
    sourcePath.length === targetPath.length;

  if (!sameParent && !sameDepthAcrossParents) {
    return rejectedMove(nodes, '拖拽不能改变任务层级，只能在同一层级内排序。');
  }

  const extracted = extractPlanNode(nodes, draggedId);
  if (!extracted) return rejectedMove(nodes, '找不到要移动的节点。');

  const next = insertSiblingNode(
    extracted.nodes,
    target.nodeId,
    extracted.node,
    target.position,
  );
  if (!next) return rejectedMove(nodes, '找不到放置目标。');

  return { nodes: next, moved: true };
}


export function updatePlanNode(
  nodes: PlanNode[],
  id: string,
  patch: Partial<PlanNode>,
): PlanNode[] {
  const walk = (list: PlanNode[]): PlanNode[] => {
    let changed = false;
    const next = list.map((node) => {
      if (node.id === id) {
        changed = true;
        const updated: PlanNode = { ...node, ...patch };
        for (const key of Object.keys(patch) as Array<keyof PlanNode>) {
          if (patch[key] === undefined) {
            delete updated[key];
          }
        }
        return updated;
      }

      if (node.children && node.children.length > 0) {
        const children = walk(node.children);
        if (children !== node.children) {
          changed = true;
          return { ...node, children };
        }
      }

      return node;
    });

    return changed ? next : list;
  };

  return walk(nodes);
}

export interface RegeneratedLeafFields {
  title: string;
  desc?: string;
  priority?: Priority;
  estimateHours?: number;
  deps?: string[];
  acceptance?: string;
}

export interface ApplyLeafRegenerationResult {
  plan: Plan;
  depsKept: boolean;
  issues: PlanIssue[];
}

function isDependencyIssue(issue: PlanIssue): boolean {
  return issue.path === 'deps' || issue.path.includes('.deps');
}

/**
 * Replaces a single leaf's editable fields. If the new dependencies are
 * invalid (missing, non-leaf, self-referencing, or cyclic), the original
 * dependencies are restored instead of rejecting the whole regeneration.
 */
export function applyLeafRegeneration(
  plan: Plan,
  nodeId: string,
  fields: RegeneratedLeafFields,
): ApplyLeafRegenerationResult {
  const node = findPlanNode(plan.nodes, nodeId);

  if (!node) {
    return {
      plan,
      depsKept: false,
      issues: [{ path: 'nodes', message: '找不到要重新生成的节点。' }],
    };
  }

  if (isGroup(node)) {
    return {
      plan,
      depsKept: false,
      issues: [{ path: 'nodes', message: '只能重新生成叶子任务。' }],
    };
  }

  const originalDeps = node.deps ?? [];
  const patch: Partial<PlanNode> = { title: fields.title.trim() };

  if (fields.desc !== undefined) {
    patch.desc = fields.desc.trim() || undefined;
  }

  if (fields.priority !== undefined) {
    patch.priority = fields.priority;
  }

  if (fields.estimateHours !== undefined) {
    patch.estimateHours = fields.estimateHours;
  }

  if (fields.deps !== undefined) {
    patch.deps = fields.deps.length > 0 ? fields.deps : undefined;
  }

  if (fields.acceptance !== undefined) {
    patch.acceptance = fields.acceptance.trim();
  }

  const candidateNodes = updatePlanNode(plan.nodes, nodeId, patch);
  const candidatePlan: Plan = { ...plan, nodes: candidateNodes };
  const candidateIssues = validatePlan(candidatePlan);

  if (!candidateIssues.some(isDependencyIssue)) {
    return {
      plan: candidatePlan,
      depsKept: false,
      issues: candidateIssues,
    };
  }

  const fallbackNodes = updatePlanNode(plan.nodes, nodeId, {
    ...patch,
    deps: originalDeps.length > 0 ? originalDeps : undefined,
  });
  const fallbackPlan: Plan = { ...plan, nodes: fallbackNodes };
  const fallbackIssues = validatePlan(fallbackPlan);

  return {
    plan: fallbackPlan,
    depsKept: true,
    issues: fallbackIssues,
  };
}
