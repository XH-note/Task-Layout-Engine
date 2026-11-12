import { describe, expect, it } from 'vitest';

import {
  computeNodeNumbers,
  resolveDependencyNumbers,
  type PlanNode,
} from './plan';
import {
  computePlanSummary,
  computePlanWeekRange,
  computeStageSummary,
  formatGeneratedAt,
  formatHours,
  formatWeek,
  formatWeekRange,
} from './summary';

function sampleNodes(): PlanNode[] {
  return [
    {
      id: 'stage-a',
      title: '阶段一',
      children: [
        { id: 'a1', title: '任务 A1', estimateHours: 2, deps: ['b2'] },
        {
          id: 'a2',
          title: '任务 A2',
          children: [
            { id: 'a2a', title: '子任务 A2a', estimateHours: 0.5 },
            { id: 'a2b', title: '子任务 A2b', estimateHours: 3.5 },
          ],
        },
      ],
    },
    {
      id: 'stage-b',
      title: '阶段二',
      children: [
        { id: 'b1', title: '任务 B1', estimateHours: 4 },
        { id: 'b2', title: '任务 B2', estimateHours: 1 },
      ],
    },
  ];
}

describe('computeStageSummary', () => {
  it('counts descendant tasks, leaves, and leaf hours', () => {
    const [stageA] = sampleNodes();

    expect(computeStageSummary(stageA!)).toEqual({
      taskCount: 4,
      totalHours: 6,
    });
  });

  it('returns zero for a stage without descendants', () => {
    expect(computeStageSummary({ id: 'empty', title: '空阶段' })).toEqual({
      taskCount: 0,
      totalHours: 0,
    });
  });
});

describe('computePlanSummary', () => {
  it('summarizes stages, leaves, hours, and the known week range', () => {
    const summary = computePlanSummary({
      nodes: sampleNodes(),
      milestones: [{ name: '演练', week: 2 }, { name: '上线', week: 4 }],
    });

    expect(summary).toEqual({
      stageCount: 2,
      leafCount: 5,
      totalHours: 11,
      weekRange: { start: 2, end: 4 },
    });
  });

  it('ignores non-finite or missing hours', () => {
    const summary = computePlanSummary({
      nodes: [
        {
          id: 'stage',
          title: '阶段',
          children: [
            { id: 'leaf', title: '任务', estimateHours: Number.NaN },
          ],
        },
      ],
      milestones: [],
    });

    expect(summary.totalHours).toBe(0);
    expect(summary.leafCount).toBe(1);
  });
});

describe('computePlanWeekRange', () => {
  it('combines node weeks and milestone weeks without dropping either', () => {
    const nodes: PlanNode[] = [
      { id: 'a', title: 'A', startWeek: 1, endWeek: 3 },
      { id: 'b', title: 'B', endWeek: 4 },
    ];

    expect(computePlanWeekRange(nodes, [{ name: '里程碑', week: 9 }])).toEqual({
      start: 1,
      end: 9,
    });
  });

  it('uses milestone weeks when nodes have none', () => {
    expect(
      computePlanWeekRange(sampleNodes(), [
        { name: '启动', week: 2 },
        { name: '上线', week: 6 },
      ]),
    ).toEqual({ start: 2, end: 6 });
  });

  it('returns null when no week data exists', () => {
    expect(computePlanWeekRange(sampleNodes(), [])).toBeNull();
  });

  it('ignores invalid week values', () => {
    const nodes: PlanNode[] = [
      { id: 'a', title: 'A', startWeek: Number.NaN, endWeek: 0 },
    ];

    expect(
      computePlanWeekRange(nodes, [{ name: '里程碑', week: -1 }]),
    ).toBeNull();
  });
});

describe('formatWeekRange', () => {
  it('formats a range, a single week, and a missing range', () => {
    expect(formatWeekRange({ start: 1, end: 6 })).toBe('W1–W6');
    expect(formatWeekRange({ start: 3, end: 3 })).toBe('W3');
    expect(formatWeekRange(null)).toBe('未指定');
  });
});

describe('formatWeek', () => {
  it('formats a valid week and rejects invalid ones', () => {
    expect(formatWeek(3)).toBe('W3');
    expect(formatWeek(0)).toBe('未指定');
    expect(formatWeek(undefined)).toBe('未指定');
  });
});

describe('formatHours', () => {
  it('keeps whole numbers and one decimal place', () => {
    expect(formatHours(2)).toBe('2 小时');
    expect(formatHours(2.5)).toBe('2.5 小时');
    expect(formatHours(0.5)).toBe('0.5 小时');
    expect(formatHours(0)).toBe('0 小时');
    expect(formatHours(Number.NaN)).toBe('—');
  });
});

describe('formatGeneratedAt', () => {
  it('does not invent a time for an unparsable value', () => {
    expect(formatGeneratedAt('not-a-date')).toBe('未记录');
  });
});

describe('resolveDependencyNumbers', () => {
  it('maps dependency ids to live tree numbers in order', () => {
    const numbers = computeNodeNumbers(sampleNodes());

    expect(resolveDependencyNumbers(['b2', 'a1'], numbers)).toEqual([
      '2.2',
      '1.1',
    ]);
    expect(resolveDependencyNumbers(undefined, numbers)).toEqual([]);
  });

  it('surfaces ids that are no longer in the tree', () => {
    const numbers = computeNodeNumbers(sampleNodes());

    expect(resolveDependencyNumbers(['a1', 'missing'], numbers)).toEqual([
      '1.1',
      '未知编号',
    ]);
  });

  it('renumbers dependencies after stages are reordered', () => {
    const nodes = sampleNodes();
    const before = computeNodeNumbers(nodes);
    expect(resolveDependencyNumbers(['b2'], before)).toEqual(['2.2']);

    const after = computeNodeNumbers([nodes[1]!, nodes[0]!]);
    expect(resolveDependencyNumbers(['b2'], after)).toEqual(['1.2']);
  });
});
