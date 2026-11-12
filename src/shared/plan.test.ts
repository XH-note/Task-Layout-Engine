import { describe, expect, it } from 'vitest';

import {
  cloneWirePlan,
  findWireNode,
  validWirePlan,
} from '../test-support/wire-plan';
import {
  computeNodeNumbers,
  normalizeWirePlan,
  validatePlan,
  type PlanNode,
} from './plan';

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
