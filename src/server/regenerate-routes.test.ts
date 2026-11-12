import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectLeaves,
  computeNodeNumbers,
  findPlanNode,
  type PlanRecord,
} from '../shared/plan';
import { buildApp } from './app';
import type { CallModel, ChatResult } from './llm';
import { PlanStore } from './plan-store';
import { SettingsStore } from './settings-store';
import {
  cloneWirePlan,
  findWireNode,
  validWireJson,
} from '../test-support/wire-plan';

let dataDir: string;
let app: FastifyInstance | null = null;

function modelReply(content: string): ChatResult {
  return {
    content,
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 200 },
    raw: { choices: [] },
  };
}

async function buildTestApp(callModel: CallModel): Promise<PlanStore> {
  const settingsStore = new SettingsStore(dataDir);

  await settingsStore.save({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    extraBody: '{}',
    apiKey: 'test-key',
    persistKey: true,
  });

  const planStore = new PlanStore(dataDir);
  const instance = buildApp(
    { logger: false },
    { settingsStore, planStore, callModel },
  );

  app = instance;
  await instance.ready();
  return planStore;
}

async function seedPlan(): Promise<PlanRecord> {
  const response = await app!.inject({
    method: 'POST',
    url: '/api/generate',
    payload: { source: '把旧系统迁移到新平台。' },
  });

  expect(response.statusCode).toBe(201);
  return (response.json() as { record: PlanRecord }).record;
}

function regenerate(planId: string, nodeId: string) {
  return app!.inject({
    method: 'POST',
    url: `/api/plans/${planId}/nodes/${nodeId}/regenerate`,
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-regenerate-'));
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('POST /api/plans/:id/nodes/:nodeId/regenerate', () => {
  it('replaces only the target leaf and keeps its id, position, and number', async () => {
    const wire = cloneWirePlan();
    const sourceLeaf = findWireNode(wire, 'n2');
    expect(sourceLeaf).toBeDefined();
    if (!sourceLeaf) return;

    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      if (calls === 1) return modelReply(validWireJson());
      return modelReply(
        JSON.stringify({
          ...sourceLeaf,
          title: '盘点依赖（更新）',
          desc: '重新核对依赖。',
          priority: 'P0',
          estimateHours: 2,
          acceptance: '依赖清单已核对。',
          children: [],
        }),
      );
    };
    const planStore = await buildTestApp(callModel);
    const record = await seedPlan();
    const leaf = collectLeaves(record.plan.nodes).find(
      (item) => item.title === '盘点依赖',
    );
    expect(leaf).toBeDefined();
    if (!leaf) return;

    const response = await regenerate(record.id, leaf.id);

    expect(response.statusCode).toBe(200);
    const result = response.json() as { record: PlanRecord; warning?: string };
    expect(result.warning).toBeUndefined();
    expect(result.record.id).toBe(record.id);
    expect(result.record.title).toBe(record.title);
    expect(findPlanNode(result.record.plan.nodes, leaf.id)).toMatchObject({
      id: leaf.id,
      title: '盘点依赖（更新）',
      desc: '重新核对依赖。',
      priority: 'P0',
      estimateHours: 2,
      acceptance: '依赖清单已核对。',
    });
    expect(computeNodeNumbers(result.record.plan.nodes).get(leaf.id)).toBe(
      computeNodeNumbers(record.plan.nodes).get(leaf.id),
    );
    const other = collectLeaves(record.plan.nodes).find(
      (item) => item.id !== leaf.id,
    );
    expect(other).toBeDefined();
    if (!other) return;
    expect(findPlanNode(result.record.plan.nodes, other.id)).toEqual(other);
    expect(await planStore.get(record.id)).toEqual(result.record);
  });

  it('keeps the original deps and returns a warning when the new ones are invalid', async () => {
    const wire = cloneWirePlan();
    const sourceLeaf = findWireNode(wire, 'n8');
    expect(sourceLeaf).toBeDefined();
    if (!sourceLeaf) return;

    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      if (calls === 1) return modelReply(validWireJson());
      return modelReply(
        JSON.stringify({
          ...sourceLeaf,
          title: '切换 DNS（更新）',
          deps: ['missing-node'],
          children: [],
        }),
      );
    };
    await buildTestApp(callModel);
    const record = await seedPlan();
    const leaf = collectLeaves(record.plan.nodes).find(
      (item) => item.title === '切换 DNS',
    );
    expect(leaf).toBeDefined();
    if (!leaf) return;

    const response = await regenerate(record.id, leaf.id);

    expect(response.statusCode).toBe(200);
    const result = response.json() as { record: PlanRecord; warning?: string };
    expect(result.warning).toBe('新结果的依赖不合法，已保留原依赖。');
    expect(findPlanNode(result.record.plan.nodes, leaf.id)?.deps).toEqual(
      leaf.deps,
    );
  });

  it('leaves the record untouched when the provider keeps returning invalid output', async () => {
    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      return modelReply(calls === 1 ? validWireJson() : '无法完成。');
    };
    const planStore = await buildTestApp(callModel);
    const record = await seedPlan();
    const leaf = collectLeaves(record.plan.nodes)[0];
    expect(leaf).toBeDefined();
    if (!leaf) return;

    const response = await regenerate(record.id, leaf.id);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'OUTPUT_INVALID', retryable: true },
    });
    expect(await planStore.get(record.id)).toEqual(record);
  });

  it('rejects unknown plans and non-leaf nodes', async () => {
    const callModel: CallModel = async () => modelReply(validWireJson());
    await buildTestApp(callModel);

    const missing = await regenerate('missing-plan', 'missing-node');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    const record = await seedPlan();
    const nonLeaf = await regenerate(record.id, record.plan.nodes[0]!.id);
    expect(nonLeaf.statusCode).toBe(400);
    expect(nonLeaf.json()).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    });

    const missingNode = await regenerate(record.id, 'missing-node');
    expect(missingNode.statusCode).toBe(404);
  });
});
