import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PlanRecord } from '../shared/plan';
import { PLAN_ARCHIVE_VERSION } from '../shared/plan-archive';
import { buildApp } from './app';
import { PlanStore } from './plan-store';
import { SettingsStore } from './settings-store';

let dataDir: string;
let app: FastifyInstance | null = null;
let planStore: PlanStore;

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
    usage: { promptTokens: 12, completionTokens: 34 },
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-archive-'));
  planStore = new PlanStore(dataDir);
  const settingsStore = new SettingsStore(dataDir);
  await settingsStore.save({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    extraBody: '{}',
    apiKey: 'sk-archive-secret',
    persistKey: true,
  });
  app = buildApp({ logger: false }, { planStore, settingsStore });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('plan archive routes', () => {
  it('exports every stored plan with the archive version and no secrets', async () => {
    await planStore.create(record('one', '计划一'));
    await planStore.create(record('two', '计划二'));

    const response = await app!.inject({ method: 'GET', url: '/api/plans/export' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe(PLAN_ARCHIVE_VERSION);
    expect(body.plans.map((plan: { id: string }) => plan.id).sort()).toEqual(['one', 'two']);
    expect(response.body).not.toMatch(/sk-archive-secret/);
    expect(response.body).not.toMatch(/api[-_]?key/i);
  });

  it('imports valid records and persists them', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/plans/import',
      payload: { schemaVersion: PLAN_ARCHIVE_VERSION, plans: [record('imported')] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      imported: 1,
      skipped: 0,
      plans: [{ id: 'imported', title: '导入计划' }],
    });

    const reloaded = new PlanStore(dataDir);
    expect(await reloaded.get('imported')).not.toBeNull();
  });

  it('skips invalid records while importing the valid ones', async () => {
    const broken = record('broken');
    broken.plan.nodes = [];

    const response = await app!.inject({
      method: 'POST',
      url: '/api/plans/import',
      payload: { schemaVersion: PLAN_ARCHIVE_VERSION, plans: [record('good'), broken] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ imported: 1, skipped: 1 });
    expect(body.plans).toHaveLength(1);
    expect(body.skippedReasons).toHaveLength(1);
  });

  it('reassigns conflicting ids so imported plans open normally', async () => {
    await planStore.create(record('clash', '已有计划'));

    const response = await app!.inject({
      method: 'POST',
      url: '/api/plans/import',
      payload: { schemaVersion: PLAN_ARCHIVE_VERSION, plans: [record('clash', '导入计划')] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.imported).toBe(1);
    expect(body.plans).toHaveLength(2);

    const imported = body.plans.find((plan: { title: string }) => plan.title === '导入计划');
    expect(imported.id).not.toBe('clash');

    const detail = await app!.inject({ method: 'GET', url: `/api/plans/${imported.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().title).toBe('导入计划');
  });

  it('rejects archives from a newer app version with a reason', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/plans/import',
      payload: { schemaVersion: PLAN_ARCHIVE_VERSION + 1, plans: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'VERSION_TOO_NEW' });
    expect(response.json().error.message).toContain('升级应用');
  });

  it('rejects payloads that are not an archive', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/plans/import',
      payload: { schemaVersion: PLAN_ARCHIVE_VERSION, plans: 'nope' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_INPUT');
  });

  it('accepts backups larger than the default 1 MiB body limit', async () => {
    const big = record('big');
    big.plan.nodes[0]!.children![0]!.desc = 'x'.repeat(1.5 * 1024 * 1024);

    const response = await app!.inject({
      method: 'POST',
      url: '/api/plans/import',
      payload: { schemaVersion: PLAN_ARCHIVE_VERSION, plans: [big] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ imported: 1 });
  });
});
