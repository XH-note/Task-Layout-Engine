import { describe, expect, it } from 'vitest';

import {
  cloneWirePlan,
  findWireNode,
  validWirePlan,
} from '../test-support/wire-plan';
import {
  applyLeafRegeneration,
  collectLeafOptions,
  collectSubtreeIds,
  computeNodeNumbers,
  countDependenciesTo,
  createLeafDraft,
  findPlanNode,
  findPlanNodePath,
  insertChildNode,
  movePlanNode,
  normalizeWirePlan,
  removePlanNode,
  updatePlanNode,
  validatePlan,
  type PlanNode,
} from './plan';
import { planSchema } from './plan-schema';

function sequentialIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
}

function normalized() {
  return normalizeWirePlan(validWirePlan(), {
    createId: sequentialIds(),
    generatedAt: '2026-11-12T09:00:00.000Z',
    model: 'deepseek-flash',
    source: 'paste',
  });
}

function issueMessages(plan: Parameters<typeof validatePlan>[0], generated = false) {
  return validatePlan(plan, { requireGeneratedShape: generated }).map(
    (issue) => `${issue.path}: ${issue.message}`,
  );
}

describe('normalizeWirePlan', () => {
  it('removes execution placeholders from groups and keeps leaf fields', () => {
    const { plan, issues } = normalized();
    expect(issues).toEqual([]);

    const [prepare] = plan.nodes;
    expect(prepare).toMatchObject({ title: '准备阶段', id: 'id-1' });
    expect(prepare).not.toHaveProperty('priority');
    expect(prepare).not.toHaveProperty('estimateHours');
    expect(prepare).not.toHaveProperty('deps');
    expect(prepare).not.toHaveProperty('acceptance');

    const [firstLeaf] = prepare.children ?? [];
    expect(firstLeaf).toMatchObject({
      id: 'id-2',
      title: '盘点依赖',
      priority: 'P1',
      estimateHours: 2,
      acceptance: '盘点依赖的验收标准',
    });
    expect(firstLeaf).not.toHaveProperty('children');
  });

  it('maps dependency keys to the generated stable ids', () => {
    const { plan } = normalized();
    const switchDns = plan.nodes[1]?.children?.[1];

    expect(switchDns).toMatchObject({ id: 'id-8', title: '切换 DNS' });
    expect(switchDns?.deps).toEqual(['id-5']);
  });

  it('converts milestone weeks and drops blank placeholders', () => {
    const wire = cloneWirePlan();
    wire.milestones = [
      { name: '演练', week: 'W2' },
      { name: '上线', week: '' },
      { name: '  ', week: 'W4' },
    ];

    const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(plan.milestones).toEqual([{ name: '演练', week: 2 }, { name: '上线' }]);
  });

  it('trims text, filters blank plan-level list items, and fills meta', () => {
    const wire = cloneWirePlan();
    wire.title = '  迁移计划  ';
    wire.risks = ['  风险一  ', '   '];
    wire.acceptance = ['', '  验收一  '];

    const { plan } = normalizeWirePlan(wire, {
      createId: sequentialIds(),
      generatedAt: '2026-11-12T09:00:00.000Z',
      model: 'deepseek-flash',
    });

    expect(plan.title).toBe('迁移计划');
    expect(plan.risks).toEqual(['风险一']);
    expect(plan.acceptance).toEqual(['验收一']);
    expect(plan.meta).toEqual({
      generatedAt: '2026-11-12T09:00:00.000Z',
      source: 'paste',
      model: 'deepseek-flash',
      version: '1',
    });
  });

  it('reports duplicate wire keys', () => {
    const wire = cloneWirePlan();
    findWireNode(wire, 'n3')!.key = 'n2';

    const { issues } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issues.map((issue) => issue.path)).toContain('nodes[0].children[1].key');
  });

  it('strips execution fields from a group instead of reporting them', () => {
    const wire = cloneWirePlan();
    wire.nodes[0]!.priority = 'P0';
    wire.nodes[0]!.estimateHours = 3;
    wire.nodes[0]!.acceptance = '不应保留';

    const { plan, issues } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issues).toEqual([]);
    expect(plan.nodes[0]).not.toHaveProperty('priority');
    expect(plan.nodes[0]).not.toHaveProperty('estimateHours');
    expect(plan.nodes[0]).not.toHaveProperty('acceptance');
  });
});

describe('computeNodeNumbers', () => {
  it('numbers nodes by their position at any depth', () => {
    const nodes: PlanNode[] = [
      {
        id: 'a',
        title: 'A',
        children: [
          {
            id: 'b',
            title: 'B',
            children: [{ id: 'c', title: 'C' }],
          },
          { id: 'd', title: 'D' },
        ],
      },
      { id: 'e', title: 'E' },
    ];

    expect([...computeNodeNumbers(nodes)]).toEqual([
      ['a', '1'],
      ['b', '1.1'],
      ['c', '1.1.1'],
      ['d', '1.2'],
      ['e', '2'],
    ]);
  });
});

describe('validatePlan', () => {
  it('accepts a valid generated plan with 12 leaves in 3 stages', () => {
    const { plan } = normalized();

    expect(issueMessages(plan, true)).toEqual([]);
  });

  it('rejects nodes with an empty title', () => {
    const { plan } = normalized();
    const inventory = plan.nodes[0]!.children![0]!;
    inventory.title = '   ';

    expect(validatePlan(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'nodes[0].children[0].title',
          message: '节点标题不能为空。',
        }),
      ]),
    );
  });

  it('rejects plans whose top-level node is not a stage', () => {
    const { plan } = normalized();
    plan.nodes.push({
      id: 'stray',
      title: '散落任务',
      priority: 'P1',
      estimateHours: 2,
      acceptance: '验收',
    });

    expect(issueMessages(plan, true)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('阶段必须包含任务'),
      ]),
    );
  });

  it('rejects trees deeper than three levels', () => {
    const wire = cloneWirePlan();
    const inventory = findWireNode(wire, 'n2')!;
    inventory.children = [
      {
        key: 'n16',
        title: '第四层',
        desc: '',
        priority: 'P1',
        estimateHours: 1,
        deps: [],
        acceptance: '验收',
        children: [
          {
            key: 'n17',
            title: '第五层',
            desc: '',
            priority: 'P1',
            estimateHours: 1,
            deps: [],
            acceptance: '验收',
            children: [],
          },
        ],
      },
    ];

    const parsed = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issueMessages(parsed.plan)).toEqual(
      expect.arrayContaining([expect.stringContaining('最多 3 层')]),
    );
  });

  it('rejects dependency cycles', () => {
    const wire = cloneWirePlan();
    findWireNode(wire, 'n2')!.deps = ['n3'];
    findWireNode(wire, 'n3')!.deps = ['n2'];

    const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issueMessages(plan)).toEqual(
      expect.arrayContaining([expect.stringContaining('依赖成环')]),
    );
  });

  it('rejects dependencies that point at missing or non-leaf nodes', () => {
    const missing = cloneWirePlan();
    findWireNode(missing, 'n2')!.deps = ['n99'];
    const missingPlan = normalizeWirePlan(missing, {
      createId: sequentialIds(),
    });
    expect(missingPlan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('不存在的任务') }),
      ]),
    );

    const groupTarget = cloneWirePlan();
    findWireNode(groupTarget, 'n2')!.deps = ['n1'];
    const groupPlan = normalizeWirePlan(groupTarget, {
      createId: sequentialIds(),
    });
    expect(issueMessages(groupPlan.plan)).toEqual(
      expect.arrayContaining([expect.stringContaining('只允许指向叶子')]),
    );
  });

  it('rejects a dependency on itself', () => {
    const wire = cloneWirePlan();
    findWireNode(wire, 'n2')!.deps = ['n2'];

    const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issueMessages(plan)).toEqual(
      expect.arrayContaining([expect.stringContaining('不能依赖自身')]),
    );
  });

  it('rejects leaf hours outside 0.5–8', () => {
    for (const hours of [0, 0.4, 8.5]) {
      const wire = cloneWirePlan();
      findWireNode(wire, 'n2')!.estimateHours = hours;

      const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

      expect(issueMessages(plan)).toEqual(
        expect.arrayContaining([expect.stringContaining('nodes[0].children[0].estimateHours')]),
      );
    }
  });

  it('rejects a leaf without an acceptance standard', () => {
    const wire = cloneWirePlan();
    findWireNode(wire, 'n2')!.acceptance = '   ';

    const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issueMessages(plan)).toEqual(
      expect.arrayContaining([expect.stringContaining('验收标准')]),
    );
  });

  it('rejects a leaf without a priority', () => {
    const wire = cloneWirePlan();
    findWireNode(wire, 'n2')!.priority = '';

    const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issueMessages(plan)).toEqual(
      expect.arrayContaining([expect.stringContaining('优先级')]),
    );
  });

  it('requires 12–20 leaves for a generated plan', () => {
    const wire = cloneWirePlan();
    wire.nodes[2]!.children = wire.nodes[2]!.children.slice(0, 3);

    const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issueMessages(plan, true)).toEqual(
      expect.arrayContaining([expect.stringContaining('叶子任务')]),
    );
    expect(issueMessages(plan, false)).toEqual([]);
  });

  it('requires 2–4 stages for a generated plan', () => {
    const wire = cloneWirePlan();
    wire.nodes = wire.nodes.slice(0, 1);

    const { plan } = normalizeWirePlan(wire, { createId: sequentialIds() });

    expect(issueMessages(plan, true)).toEqual(
      expect.arrayContaining([expect.stringContaining('阶段')]),
    );
  });

  it('rejects duplicate node ids', () => {
    const { plan } = normalized();
    plan.nodes[0]!.id = plan.nodes[1]!.id;

    expect(issueMessages(plan)).toEqual(
      expect.arrayContaining([expect.stringContaining('id')]),
    );
  });
});

describe('collectLeafOptions', () => {
  it('lists only leaves with their number and title path', () => {
    const { plan } = normalized();
    const options = collectLeafOptions(plan.nodes);

    expect(options).toHaveLength(12);
    expect(options[0]).toEqual({
      id: 'id-2',
      title: '盘点依赖',
      path: '准备阶段 / 盘点依赖',
      number: '1.1',
    });
    expect(options[11]).toEqual({
      id: 'id-15',
      title: '复盘总结',
      path: '收尾阶段 / 复盘总结',
      number: '3.4',
    });
  });
});

describe('findPlanNodePath', () => {
  it('returns the ancestor chain for a nested node', () => {
    const { plan } = normalized();
    const path = findPlanNodePath(plan.nodes, 'id-8');

    expect(path?.map((node) => node.title)).toEqual(['执行阶段', '切换 DNS']);
  });

  it('returns undefined for an unknown node', () => {
    const { plan } = normalized();

    expect(findPlanNodePath(plan.nodes, 'missing')).toBeUndefined();
  });
});

describe('updatePlanNode', () => {
  it('updates a nested node without mutating the original tree', () => {
    const { plan } = normalized();
    const nodes = updatePlanNode(plan.nodes, 'id-2', {
      title: '重新盘点依赖',
      estimateHours: 3,
    });

    expect(findPlanNode(nodes, 'id-2')).toMatchObject({
      title: '重新盘点依赖',
      estimateHours: 3,
    });
    expect(findPlanNode(plan.nodes, 'id-2')).toMatchObject({
      title: '盘点依赖',
      estimateHours: 2,
    });
    expect(nodes).not.toBe(plan.nodes);
    expect(nodes[0]).not.toBe(plan.nodes[0]);
  });

  it('clears an optional field when the patch value is undefined', () => {
    const { plan } = normalized();
    const nodes = updatePlanNode(plan.nodes, 'id-2', { desc: undefined });

    expect(findPlanNode(nodes, 'id-2')).not.toHaveProperty('desc');
    expect(findPlanNode(plan.nodes, 'id-2')).toHaveProperty('desc');
  });

  it('returns the original array when the node is absent', () => {
    const { plan } = normalized();

    expect(updatePlanNode(plan.nodes, 'missing', { title: 'x' })).toBe(
      plan.nodes,
    );
  });
});

describe('collectSubtreeIds', () => {
  it('collects a node and every descendant', () => {
    const { plan } = normalized();

    expect(collectSubtreeIds(plan.nodes, 'id-1')).toEqual([
      'id-1',
      'id-2',
      'id-3',
      'id-4',
      'id-5',
    ]);
    expect(collectSubtreeIds(plan.nodes, 'id-2')).toEqual(['id-2']);
  });

  it('returns an empty list for an unknown node', () => {
    const { plan } = normalized();

    expect(collectSubtreeIds(plan.nodes, 'missing')).toEqual([]);
  });
});

describe('countDependenciesTo', () => {
  it('counts dependencies pointing at the target set', () => {
    const { plan } = normalized();

    expect(countDependenciesTo(plan.nodes, ['id-5'])).toBe(1);
    expect(countDependenciesTo(plan.nodes, new Set(['id-2', 'id-5']))).toBe(1);
    expect(countDependenciesTo(plan.nodes, ['id-2'])).toBe(0);
  });
});

describe('insertChildNode', () => {
  it('appends a leaf under a stage without mutating the original tree', () => {
    const { plan } = normalized();
    const draft = createLeafDraft('id-16');
    const nodes = insertChildNode(plan.nodes, 'id-6', draft);
    const stage = findPlanNode(nodes, 'id-6');

    expect(stage?.children).toHaveLength(5);
    expect(stage?.children?.[4]).toEqual(draft);
    expect(findPlanNode(plan.nodes, 'id-6')?.children).toHaveLength(4);
    expect(validatePlan({ ...plan, nodes })).toEqual([]);
  });

  it('rejects a leaf parent and a fourth level', () => {
    const { plan } = normalized();
    const draft = createLeafDraft('id-16');

    expect(insertChildNode(plan.nodes, 'id-2', draft)).toBe(plan.nodes);

    const nested: PlanNode[] = [
      {
        id: 'stage',
        title: '阶段',
        children: [
          {
            id: 'group',
            title: '分组',
            children: [{ id: 'task', title: '任务' }],
          },
        ],
      },
    ];

    expect(insertChildNode(nested, 'task', draft)).toBe(nested);
    expect(insertChildNode(nested, 'group', draft)).not.toBe(nested);

    const tooDeep: PlanNode[] = [
      {
        id: 'stage',
        title: '阶段',
        children: [
          {
            id: 'group',
            title: '分组',
            children: [
              {
                id: 'subgroup',
                title: '子分组',
                children: [{ id: 'task', title: '任务' }],
              },
            ],
          },
        ],
      },
    ];

    expect(insertChildNode(tooDeep, 'subgroup', draft)).toBe(tooDeep);
  });

  it('returns the original array when the parent is absent', () => {
    const { plan } = normalized();

    expect(insertChildNode(plan.nodes, 'missing', createLeafDraft('id-16'))).toBe(
      plan.nodes,
    );
  });
});

describe('removePlanNode', () => {
  it('removes a leaf and clears dependencies that pointed at it', () => {
    const { plan } = normalized();
    const result = removePlanNode(plan.nodes, 'id-5');

    expect(result.removedNodeIds).toEqual(['id-5']);
    expect(result.clearedDependencies).toBe(1);
    expect(findPlanNode(result.nodes, 'id-8')).not.toHaveProperty('deps');
    expect(findPlanNode(plan.nodes, 'id-8')?.deps).toEqual(['id-5']);
    expect(validatePlan({ ...plan, nodes: result.nodes })).toEqual([]);
  });

  it('removes a group with its whole subtree', () => {
    const { plan } = normalized();
    const result = removePlanNode(plan.nodes, 'id-6');

    expect(result.removedNodeIds).toEqual([
      'id-6',
      'id-7',
      'id-8',
      'id-9',
      'id-10',
    ]);
    expect(result.nodes).toHaveLength(2);
    expect(validatePlan({ ...plan, nodes: result.nodes })).toEqual([]);
  });

  it('clears dependencies inside a removed stage and leaves the rest valid', () => {
    const { plan } = normalized();
    const result = removePlanNode(plan.nodes, 'id-1');

    expect(result.removedNodeIds).toEqual([
      'id-1',
      'id-2',
      'id-3',
      'id-4',
      'id-5',
    ]);
    expect(result.clearedDependencies).toBe(1);
    expect(findPlanNode(result.nodes, 'id-8')).not.toHaveProperty('deps');
    expect(validatePlan({ ...plan, nodes: result.nodes })).toEqual([]);
  });

  it('prunes empty ancestors after removing their last child', () => {
    const nodes: PlanNode[] = [
      {
        id: 'stage',
        title: '阶段',
        children: [
          {
            id: 'group',
            title: '分组',
            children: [{ id: 'task', title: '任务' }],
          },
        ],
      },
    ];
    const result = removePlanNode(nodes, 'task');

    expect(result.removedNodeIds).toEqual(['task', 'group', 'stage']);
    expect(result.nodes).toEqual([]);
    expect(nodes).toHaveLength(1);
  });

  it('returns the original tree when the node is absent', () => {
    const { plan } = normalized();
    const result = removePlanNode(plan.nodes, 'missing');

    expect(result.nodes).toBe(plan.nodes);
    expect(result.removedNodeIds).toEqual([]);
    expect(result.clearedDependencies).toBe(0);
  });
});

describe('movePlanNode', () => {
  it('reorders leaves inside the same stage', () => {
    const { plan } = normalized();
    const result = movePlanNode(plan.nodes, 'id-4', {
      kind: 'sibling',
      nodeId: 'id-3',
      position: 'before',
    });

    expect(result.moved).toBe(true);
    expect(result.nodes[0]?.children?.map((node) => node.title)).toEqual([
      '盘点依赖',
      '编写脚本',
      '备份数据',
      '回滚演练',
    ]);
    expect(computeNodeNumbers(result.nodes).get('id-4')).toBe('1.2');
    expect(validatePlan({ ...plan, nodes: result.nodes })).toEqual([]);
  });

  it('moves a leaf to the end of another stage', () => {
    const { plan } = normalized();
    const result = movePlanNode(plan.nodes, 'id-2', {
      kind: 'stage-end',
      stageId: 'id-6',
    });

    expect(result.moved).toBe(true);
    expect(result.nodes[0]?.children?.map((node) => node.id)).toEqual([
      'id-3',
      'id-4',
      'id-5',
    ]);
    expect(result.nodes[1]?.children?.at(-1)?.id).toBe('id-2');
    expect(computeNodeNumbers(result.nodes).get('id-2')).toBe('2.5');
    expect(validatePlan({ ...plan, nodes: result.nodes })).toEqual([]);
  });

  it('moves a task to the end of its own stage', () => {
    const { plan } = normalized();
    const result = movePlanNode(plan.nodes, 'id-3', {
      kind: 'stage-end',
      stageId: 'id-1',
    });

    expect(result.moved).toBe(true);
    expect(result.nodes[0]?.children?.map((node) => node.id)).toEqual([
      'id-2',
      'id-4',
      'id-5',
      'id-3',
    ]);
    expect(validatePlan({ ...plan, nodes: result.nodes })).toEqual([]);
  });

  it('reorders stages by their headers', () => {
    const { plan } = normalized();
    const result = movePlanNode(plan.nodes, 'id-11', {
      kind: 'stage-position',
      stageId: 'id-1',
      position: 'before',
    });

    expect(result.moved).toBe(true);
    expect(result.nodes.map((stage) => stage.title)).toEqual([
      '收尾阶段',
      '准备阶段',
      '执行阶段',
    ]);
    expect(computeNodeNumbers(result.nodes).get('id-11')).toBe('1');
    expect(validatePlan({ ...plan, nodes: result.nodes })).toEqual([]);
  });

  it('reorders a stage after a later stage', () => {
    const { plan } = normalized();
    const result = movePlanNode(plan.nodes, 'id-1', {
      kind: 'stage-position',
      stageId: 'id-11',
      position: 'after',
    });

    expect(result.moved).toBe(true);
    expect(result.nodes.map((stage) => stage.id)).toEqual([
      'id-6',
      'id-11',
      'id-1',
    ]);
  });

  it('rejects moving a stage onto a task', () => {
    const { plan } = normalized();
    const result = movePlanNode(plan.nodes, 'id-1', {
      kind: 'sibling',
      nodeId: 'id-2',
      position: 'before',
    });

    expect(result.moved).toBe(false);
    expect(result.nodes).toBe(plan.nodes);
    expect(result.reason).toContain('阶段只能');
  });

  it('rejects changing the hierarchy level when moving across depths', () => {
    const nodes: PlanNode[] = [
      {
        id: 'stage',
        title: '阶段',
        children: [
          {
            id: 'group-a',
            title: '分组 A',
            children: [
              { id: 'a1', title: '任务 A1' },
              { id: 'a2', title: '任务 A2' },
            ],
          },
          {
            id: 'group-b',
            title: '分组 B',
            children: [{ id: 'b1', title: '任务 B1' }],
          },
        ],
      },
    ];
    const result = movePlanNode(nodes, 'a1', {
      kind: 'sibling',
      nodeId: 'group-b',
      position: 'after',
    });

    expect(result.moved).toBe(false);
    expect(result.nodes).toBe(nodes);
    expect(result.reason).toContain('不能改变任务层级');
  });

  it('moves a task across groups at the same depth', () => {
    const nodes: PlanNode[] = [
      {
        id: 'stage',
        title: '阶段',
        children: [
          {
            id: 'group-a',
            title: '分组 A',
            children: [
              { id: 'a1', title: '任务 A1' },
              { id: 'a2', title: '任务 A2' },
            ],
          },
          {
            id: 'group-b',
            title: '分组 B',
            children: [{ id: 'b1', title: '任务 B1' }],
          },
        ],
      },
    ];
    const result = movePlanNode(nodes, 'a1', {
      kind: 'sibling',
      nodeId: 'b1',
      position: 'after',
    });

    expect(result.moved).toBe(true);
    const groups = result.nodes[0]?.children ?? [];
    expect(groups[0]?.children?.map((node) => node.id)).toEqual(['a2']);
    expect(groups[1]?.children?.map((node) => node.id)).toEqual(['b1', 'a1']);
  });

  it('moves a task after a later sibling', () => {
    const { plan } = normalized();
    const result = movePlanNode(plan.nodes, 'id-2', {
      kind: 'sibling',
      nodeId: 'id-4',
      position: 'after',
    });

    expect(result.moved).toBe(true);
    expect(result.nodes[0]?.children?.map((node) => node.id)).toEqual([
      'id-3',
      'id-4',
      'id-2',
      'id-5',
    ]);
  });

  it('moves a group together with its subtree', () => {
    const nodes: PlanNode[] = [
      {
        id: 's1',
        title: '阶段一',
        children: [
          {
            id: 'group-a',
            title: '分组 A',
            children: [
              { id: 'a1', title: '任务 A1' },
              { id: 'a2', title: '任务 A2' },
            ],
          },
          { id: 't1', title: '任务 T1' },
        ],
      },
      {
        id: 's2',
        title: '阶段二',
        children: [{ id: 't2', title: '任务 T2' }],
      },
    ];
    const result = movePlanNode(nodes, 'group-a', {
      kind: 'sibling',
      nodeId: 't2',
      position: 'after',
    });

    expect(result.moved).toBe(true);
    expect(result.nodes[0]?.children?.map((node) => node.id)).toEqual(['t1']);
    expect(result.nodes[1]?.children?.map((node) => node.id)).toEqual([
      't2',
      'group-a',
    ]);
    expect(result.nodes[1]?.children?.[1]?.children?.map((node) => node.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('rejects emptying a stage through a cross-stage move', () => {
    const nodes: PlanNode[] = [
      { id: 's1', title: '阶段一', children: [{ id: 't1', title: '任务一' }] },
      { id: 's2', title: '阶段二', children: [{ id: 't2', title: '任务二' }] },
    ];
    const result = movePlanNode(nodes, 't1', {
      kind: 'stage-end',
      stageId: 's2',
    });

    expect(result.moved).toBe(false);
    expect(result.reason).toContain('上级节点会变空');
  });
});

describe('createLeafDraft', () => {
  it('creates a placeholder leaf that passes leaf validation', () => {
    const { plan } = normalized();
    const draft = createLeafDraft('id-16');
    const nodes = insertChildNode(plan.nodes, 'id-6', draft);

    expect(draft).toMatchObject({
      id: 'id-16',
      title: '新任务',
      priority: 'P2',
      estimateHours: 1,
    });
    expect(draft.acceptance?.trim()).not.toBe('');
    expect(draft.children).toBeUndefined();
    expect(validatePlan({ ...plan, nodes })).toEqual([]);
  });
});

describe('applyLeafRegeneration', () => {
  it('replaces only the target leaf and keeps its id, position, and number', () => {
    const { plan } = normalized();

    const result = applyLeafRegeneration(plan, 'id-2', {
      title: '盘点依赖（更新）',
      desc: '重新核对依赖。',
      priority: 'P0',
      estimateHours: 2,
      acceptance: '依赖清单已核对。',
    });

    expect(result.issues).toEqual([]);
    expect(result.depsKept).toBe(false);
    expect(findPlanNode(result.plan.nodes, 'id-2')).toMatchObject({
      id: 'id-2',
      title: '盘点依赖（更新）',
      desc: '重新核对依赖。',
      priority: 'P0',
      estimateHours: 2,
      acceptance: '依赖清单已核对。',
    });
    expect(findPlanNode(result.plan.nodes, 'id-3')).toEqual(
      findPlanNode(plan.nodes, 'id-3'),
    );
    expect(computeNodeNumbers(result.plan.nodes).get('id-2')).toBe(
      computeNodeNumbers(plan.nodes).get('id-2'),
    );
    expect(validatePlan(result.plan)).toEqual([]);
  });

  it('keeps the original dependencies when the new ones are missing', () => {
    const { plan } = normalized();

    const result = applyLeafRegeneration(plan, 'id-8', {
      title: '切换 DNS',
      deps: ['missing-node'],
    });

    expect(result.depsKept).toBe(true);
    expect(result.issues).toEqual([]);
    expect(findPlanNode(result.plan.nodes, 'id-8')?.deps).toEqual(['id-5']);
  });

  it('keeps the original dependencies when the new ones create a cycle', () => {
    const plan = {
      ...normalized().plan,
      nodes: [
        {
          id: 'stage',
          title: '阶段',
          children: [
            {
              id: 'x',
              title: '任务 X',
              priority: 'P2' as const,
              estimateHours: 1,
              acceptance: '完成。',
            },
            {
              id: 'y',
              title: '任务 Y',
              priority: 'P2' as const,
              estimateHours: 1,
              deps: ['x'],
              acceptance: '完成。',
            },
          ],
        },
      ],
    };

    const result = applyLeafRegeneration(plan, 'x', {
      title: '任务 X',
      deps: ['y'],
    });

    expect(result.depsKept).toBe(true);
    expect(result.issues).toEqual([]);
    expect(findPlanNode(result.plan.nodes, 'x')?.deps).toBeUndefined();
  });

  it('rejects non-leaf targets and invalid fields', () => {
    const { plan } = normalized();

    expect(applyLeafRegeneration(plan, 'id-1', { title: '阶段' }).issues[0]?.message).toBe(
      '只能重新生成叶子任务。',
    );
    expect(applyLeafRegeneration(plan, 'id-2', { title: '   ' }).issues).toEqual([
      { path: 'nodes[0].children[0].title', message: '节点标题不能为空。' },
    ]);
  });
});

describe('planSchema', () => {
  it('accepts a normalized plan and rejects malformed node trees', () => {
    const { plan } = normalized();

    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(
      planSchema.safeParse({ ...plan, nodes: [{ id: 'x' }] }).success,
    ).toBe(false);
  });
});
