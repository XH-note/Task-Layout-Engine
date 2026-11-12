import type { WireNode, WirePlan } from './wire';

export type Priority = 'P0' | 'P1' | 'P2';

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

      if (depth > 3) {
        issues.push({
          path,
          message: '任务层级最多 3 层（阶段 → 任务 → 子任务）。',
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
