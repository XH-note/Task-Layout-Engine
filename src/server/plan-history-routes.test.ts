import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeWirePlan, type PlanRecord } from '../shared/plan';
import { buildApp } from './app';
import { PlanStore } from './plan-store';
import { validWirePlan } from '../test-support/wire-plan';

let dataDir: string;
let app: FastifyInstance | null = null;
let planStore: PlanStore;

function record(id: string, updatedAt: string, title = `计划 ${id}`): PlanRecord {
  const { plan } = normalizeWirePlan(validWirePlan(), {
    createId: (() => {
      let next = 0;
      return () => `${id}-node-${(next += 1)}`;
    })(),
    generatedAt: '2026-11-12T09:00:00.000Z',
    model: 'deepseek-flash',
  });
  plan.title = title;

  return {
    id,
    createdAt: '2026-11-12T09:00:00.000Z',
    updatedAt,
    title,
    plan,
    source: '粘贴内容',
    model: 'deepseek-flash',
    usage: { promptTokens: 10, completionTokens: 20 },
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-history-'));
  planStore = new PlanStore(dataDir);
  app = buildApp({ logger: false }, { planStore });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('plan history routes', () => {
  it('lists plans by updatedAt descending with usage', async () => {
    await planStore.create(record('older', '2026-11-12T09:00:00.000Z'));
    await planStore.create(record('newer', '2026-11-12T11:00:00.000Z', '新计划'));
    await planStore.create(record('middle', '2026-11-12T10:00:00.000Z'));

    const response = await app!.inject({ method: 'GET', url: '/api/plans' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plans: [
        {
          id: 'newer',
          title: '新计划',
          createdAt: '2026-11-12T09:00:00.000Z',
          updatedAt: '2026-11-12T11:00:00.000Z',
        },
        { id: 'middle' },
        { id: 'older' },
      ],
      usage: { count: 3 },
    });
    expect(response.json().usage.bytes).toBeGreaterThan(0);
  });

  it('deletes one plan and persists the deletion', async () => {
    await planStore.create(record('keep', '2026-11-12T09:00:00.000Z'));
    await planStore.create(record('drop', '2026-11-12T10:00:00.000Z'));

    const response = await app!.inject({
      method: 'DELETE',
      url: '/api/plans/drop',
    });

    expect(response.statusCode).toBe(204);

    const list = await app!.inject({ method: 'GET', url: '/api/plans' });
    expect(list.json().plans.map((plan: { id: string }) => plan.id)).toEqual([
      'keep',
    ]);

    const reloaded = new PlanStore(dataDir);
    expect(await reloaded.get('drop')).toBeNull();
    expect(await reloaded.get('keep')).not.toBeNull();
  });

  it('returns 404 when deleting an unknown plan', async () => {
    const response = await app!.inject({
      method: 'DELETE',
      url: '/api/plans/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('clears all plans', async () => {
    await planStore.create(record('one', '2026-11-12T09:00:00.000Z'));
    await planStore.create(record('two', '2026-11-12T10:00:00.000Z'));

    const response = await app!.inject({ method: 'DELETE', url: '/api/plans' });
    expect(response.statusCode).toBe(204);

    const list = await app!.inject({ method: 'GET', url: '/api/plans' });
    expect(list.json().plans).toEqual([]);
    expect(list.json().usage).toEqual({ count: 0, bytes: expect.any(Number) });

    const detail = await app!.inject({ method: 'GET', url: '/api/plans/one' });
    expect(detail.statusCode).toBe(404);
  });
});
