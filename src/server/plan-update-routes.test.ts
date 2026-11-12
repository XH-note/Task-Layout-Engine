import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectLeaves,
  createLeafDraft,
  insertChildNode,
  normalizeWirePlan,
  removePlanNode,
  type PlanNode,
  type PlanRecord,
} from '../shared/plan';
import { buildApp } from './app';
import { PlanStore } from './plan-store';
import { validWirePlan } from '../test-support/wire-plan';

let dataDir: string;
let app: FastifyInstance | null = null;
let planStore: PlanStore;

function record(id = 'plan-1'): PlanRecord {
  const { plan } = normalizeWirePlan(validWirePlan(), {
    createId: (() => {
      let next = 0;
      return () => `node-${(next += 1)}`;
    })(),
    generatedAt: '2026-11-12T09:00:00.000Z',
    model: 'deepseek-flash',
  });

  return {
    id,
    createdAt: '2026-11-12T09:00:00.000Z',
    updatedAt: '2026-11-12T09:00:00.000Z',
    title: plan.title,
    plan,
    source: '粘贴内容',
    model: 'deepseek-flash',
    usage: { promptTokens: 10, completionTokens: 20 },
  };
}

function leafByTitle(nodes: PlanNode[], title: string): PlanNode {
  const leaf = collectLeaves(nodes).find((node) => node.title === title);
  if (!leaf) throw new Error(`missing leaf: ${title}`);
  return leaf;
}

async function seed(): Promise<PlanRecord> {
  const created = record();
  await planStore.create(created);
  return created;
}

function put(id: string, payload: Record<string, unknown>) {
  return app!.inject({
    method: 'PUT',
    url: `/api/plans/${id}`,
    payload,
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-update-'));
  planStore = new PlanStore(dataDir);
  app = buildApp({ logger: false }, { planStore });
  await app.ready();
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('PUT /api/plans/:id', () => {
  it('persists node edits and keeps the record title in sync', async () => {
    const created = await seed();
    const plan = structuredClone(created.plan);
    plan.title = '迁移计划（修订）';
    const inventory = leafByTitle(plan.nodes, '盘点依赖');
    inventory.title = '重新盘点依赖';
    inventory.estimateHours = 4;

    const response = await put(created.id, { title: '迁移计划（修订）', plan });

    expect(response.statusCode).toBe(200);
    const updated = response.json<PlanRecord>();
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.title).toBe('迁移计划（修订）');
    expect(updated.plan.title).toBe('迁移计划（修订）');
    expect(leafByTitle(updated.plan.nodes, '重新盘点依赖')).toMatchObject({
      estimateHours: 4,
    });

    const stored = await planStore.get(created.id);
    expect(stored).toEqual(updated);

    const fetched = await app!.inject({
      method: 'GET',
      url: `/api/plans/${created.id}`,
    });
    expect(fetched.json<PlanRecord>()).toEqual(updated);
  });

  it('persists added and removed nodes through autosave', async () => {
    const created = await seed();
    const nodes = insertChildNode(
      created.plan.nodes,
      'node-1',
      createLeafDraft('new-node'),
    );
    const removal = removePlanNode(nodes, 'node-5');
    const plan = { ...created.plan, nodes: removal.nodes };

    expect(removal.clearedDependencies).toBe(1);

    const response = await put(created.id, { title: created.title, plan });

    expect(response.statusCode).toBe(200);
    const updated = response.json<PlanRecord>();
    expect(collectLeaves(updated.plan.nodes)).toHaveLength(12);
    expect(leafByTitle(updated.plan.nodes, '新任务')).toMatchObject({
      id: 'new-node',
      estimateHours: 1,
    });
    expect(leafByTitle(updated.plan.nodes, '切换 DNS')).not.toHaveProperty(
      'deps',
    );

    const fetched = await app!.inject({
      method: 'GET',
      url: `/api/plans/${created.id}`,
    });
    expect(fetched.json<PlanRecord>()).toEqual(updated);
  });

  it('rejects dependency cycles with 422 INTEGRITY and a nodePath', async () => {
    const created = await seed();
    const plan = structuredClone(created.plan);
    const inventory = leafByTitle(plan.nodes, '盘点依赖');
    const backup = leafByTitle(plan.nodes, '备份数据');
    inventory.deps = [backup.id];
    backup.deps = [inventory.id];

    const response = await put(created.id, { title: created.title, plan });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      error: { code: string; message: string; nodePath: string };
    }>();
    expect(body.error.code).toBe('INTEGRITY');
    expect(body.error.message).toContain('依赖成环');
    expect(body.error.nodePath).toBe('nodes[0].children[1].deps');
    await expect(planStore.get(created.id)).resolves.toEqual(created);
  });

  it('rejects dangling dependencies with 422 and leaves stored data untouched', async () => {
    const created = await seed();
    const plan = structuredClone(created.plan);
    leafByTitle(plan.nodes, '盘点依赖').deps = ['missing-node'];

    const response = await put(created.id, { title: created.title, plan });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      error: { code: string; message: string; nodePath: string };
    }>();
    expect(body.error.code).toBe('INTEGRITY');
    expect(body.error.message).toContain('不存在的任务');
    expect(body.error.nodePath).toBe('nodes[0].children[0].deps[0]');
    await expect(planStore.get(created.id)).resolves.toEqual(created);
  });

  it('rejects an empty plan title with 422', async () => {
    const created = await seed();

    const response = await put(created.id, {
      title: '   ',
      plan: created.plan,
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      error: { code: string; nodePath: string };
    }>();
    expect(body.error.code).toBe('INTEGRITY');
    expect(body.error.nodePath).toBe('title');
  });

  it('rejects a request title that differs from the plan title', async () => {
    const created = await seed();

    const response = await put(created.id, {
      title: '另一个标题',
      plan: created.plan,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    });
    await expect(planStore.get(created.id)).resolves.toEqual(created);
  });

  it('rejects a structurally invalid plan with 400 INVALID_INPUT', async () => {
    const created = await seed();

    const response = await put(created.id, {
      title: created.title,
      plan: { title: created.title },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('returns 404 for an unknown plan id', async () => {
    const response = await put('missing', {
      title: 'x',
      plan: record().plan,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});
