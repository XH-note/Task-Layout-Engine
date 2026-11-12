import { describe, expect, it } from 'vitest';

import type { PlanRecord } from './plan';
import {
  PLAN_ARCHIVE_VERSION,
  migratePlanArchive,
  preparePlanImport,
} from './plan-archive';

function record(id: string, title = '导入计划'): PlanRecord {
  return {
    id,
    createdAt: '2026-11-12T09:00:00.000Z',
    updatedAt: '2026-11-12T09:00:00.000Z',
    title,
    plan: {
      title,
      goal: '在不中断业务的前提下完成迁移。',
      background: '旧系统维护成本持续上升。',
      risks: ['切换窗口内流量异常'],
      milestones: [{ name: '完成演练', week: 2 }],
      acceptance: ['新系统承接全部流量一周'],
      nodes: [
        {
          id: `${id}-stage`,
          title: '准备阶段',
          children: [
            {
              id: `${id}-leaf`,
              title: '盘点依赖',
              priority: 'P1',
              estimateHours: 2,
              acceptance: '依赖清单确认',
            },
          ],
        },
      ],
      meta: {
        generatedAt: '2026-11-12T09:00:00.000Z',
        source: 'paste',
        model: 'deepseek-flash',
        version: '1',
      },
    },
    source: 'paste',
    model: 'deepseek-flash',
    usage: null,
  };
}

function sequentialId(): () => string {
  let next = 0;
  return () => `import-${(next += 1)}`;
}

describe('migratePlanArchive', () => {
  it('accepts the current archive version as-is', () => {
    const result = migratePlanArchive({
      schemaVersion: PLAN_ARCHIVE_VERSION,
      plans: [record('one')],
    });

    expect(result).toMatchObject({
      ok: true,
      archive: { schemaVersion: PLAN_ARCHIVE_VERSION },
    });
    if (result.ok) expect(result.archive.plans).toHaveLength(1);
  });

  it('migrates legacy bare-array archives to the current version', () => {
    const result = migratePlanArchive([record('one')]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.archive.schemaVersion).toBe(PLAN_ARCHIVE_VERSION);
      expect(result.archive.plans).toHaveLength(1);
    }
  });

  it('migrates archives that still carry version 0', () => {
    const result = migratePlanArchive({ schemaVersion: 0, plans: [record('one')] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.archive.schemaVersion).toBe(PLAN_ARCHIVE_VERSION);
  });

  it('rejects archives created by a newer app version', () => {
    const result = migratePlanArchive({
      schemaVersion: PLAN_ARCHIVE_VERSION + 1,
      plans: [],
    });

    expect(result).toMatchObject({ ok: false, code: 'VERSION_TOO_NEW' });
    if (!result.ok) expect(result.message).toContain('升级应用');
  });

  it('rejects payloads that are not an archive', () => {
    expect(migratePlanArchive(null)).toMatchObject({ ok: false, code: 'INVALID_ARCHIVE' });
    expect(migratePlanArchive({ schemaVersion: 1, plans: 'nope' })).toMatchObject({
      ok: false,
      code: 'INVALID_ARCHIVE',
    });
    expect(migratePlanArchive({ schemaVersion: 1.5, plans: [] })).toMatchObject({
      ok: false,
      code: 'INVALID_ARCHIVE',
    });
  });
});

describe('preparePlanImport', () => {
  it('keeps valid records and reports skipped ones with reasons', () => {
    const result = preparePlanImport(
      [record('good'), { id: 'broken', title: '缺字段' }, 'not-an-object'],
      [],
    );

    expect(result.records.map((item) => item.id)).toEqual(['good']);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].index).toBe(1);
    expect(result.skipped[0].message.length).toBeGreaterThan(0);
  });

  it('normalizes the record title to the plan title', () => {
    const raw = record('one', '旧标题');
    raw.title = '过期标题';
    raw.plan.title = '新标题';

    const result = preparePlanImport([raw], []);

    expect(result.records[0].title).toBe('新标题');
    expect(result.records[0].plan.title).toBe('新标题');
  });

  it('reassigns ids that collide with stored plans', () => {
    const result = preparePlanImport([record('existing')], ['existing'], {
      createId: sequentialId(),
    });

    expect(result.records[0].id).toBe('import-1');
    expect(result.records[0].plan.nodes[0].id).toBe('existing-stage');
  });

  it('reassigns duplicate ids inside the same archive', () => {
    const result = preparePlanImport([record('same'), record('same')], [], {
      createId: sequentialId(),
    });

    expect(result.records.map((item) => item.id)).toEqual(['same', 'import-1']);
  });

  it('skips records whose plan fails integrity validation', () => {
    const raw = record('broken');
    raw.plan.nodes = [];

    const result = preparePlanImport([raw], []);

    expect(result.records).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].message).toContain('计划');
  });
});
