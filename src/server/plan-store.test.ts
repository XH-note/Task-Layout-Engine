import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from './errors';
import { PLANS_FILE_NAME, PlanStore } from './plan-store';
import type { PlanRecord } from '../shared/plan';
import { normalizeWirePlan } from '../shared/plan';
import { validWirePlan } from '../test-support/wire-plan';

let dataDir: string;

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

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-plans-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('PlanStore', () => {
  it('persists a record atomically and reads it back from a fresh instance', async () => {
    const store = new PlanStore(dataDir);
    const created = await store.create(record());

    const raw = JSON.parse(
      await fs.readFile(path.join(dataDir, PLANS_FILE_NAME), 'utf8'),
    ) as { schemaVersion: number; plans: PlanRecord[] };

    expect(raw.schemaVersion).toBe(1);
    expect(raw.plans).toHaveLength(1);

    const reopened = new PlanStore(dataDir);
    await expect(reopened.get(created.id)).resolves.toEqual(created);
    await expect(reopened.get('missing')).resolves.toBeNull();
  });

  it('keeps newest records first', async () => {
    const store = new PlanStore(dataDir);
    await store.create(record('older'));
    await store.create(record('newer'));

    const raw = JSON.parse(
      await fs.readFile(path.join(dataDir, PLANS_FILE_NAME), 'utf8'),
    ) as { plans: PlanRecord[] };

    expect(raw.plans.map((plan) => plan.id)).toEqual(['newer', 'older']);
  });

  it('updates an existing record in place and persists it', async () => {
    const store = new PlanStore(dataDir);
    const created = await store.create(record('kept'));
    await store.create(record('other'));

    const updated: PlanRecord = {
      ...created,
      title: '更新后的标题',
      updatedAt: '2026-11-12T10:00:00.000Z',
      plan: { ...created.plan, title: '更新后的标题' },
    };
    await expect(store.update(updated)).resolves.toEqual(updated);

    const raw = JSON.parse(
      await fs.readFile(path.join(dataDir, PLANS_FILE_NAME), 'utf8'),
    ) as { plans: PlanRecord[] };

    expect(raw.plans.map((plan) => plan.id)).toEqual(['other', 'kept']);
    await expect(new PlanStore(dataDir).get('kept')).resolves.toEqual(updated);
  });

  it('rejects an update based on a stale snapshot', async () => {
    const store = new PlanStore(dataDir);
    const created = await store.create(record('kept'));
    const updated: PlanRecord = {
      ...created,
      title: '更新后的标题',
      updatedAt: '2026-11-12T10:00:00.000Z',
      plan: { ...created.plan, title: '更新后的标题' },
    };
    await store.update(updated);

    const failure = await store
      .update(
        { ...updated, title: '过期标题' },
        { expectedUpdatedAt: created.updatedAt },
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('CONFLICT');
    await expect(store.get('kept')).resolves.toEqual(updated);
  });

  it('rejects updating a record that does not exist', async () => {
    const store = new PlanStore(dataDir);
    const failure = await store
      .update(record('missing'))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('NOT_FOUND');
  });

  it('refuses data files written by a newer schema version', async () => {
    await fs.writeFile(
      path.join(dataDir, PLANS_FILE_NAME),
      JSON.stringify({ schemaVersion: 2, plans: [] }),
      'utf8',
    );

    const store = new PlanStore(dataDir);
    const failure = await store.get('any').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('STORAGE');
    expect((failure as AppError).message).toContain('请升级应用');
  });

  it('fails clearly when the data file is corrupt', async () => {
    await fs.writeFile(path.join(dataDir, PLANS_FILE_NAME), '{not json', 'utf8');

    const store = new PlanStore(dataDir);
    const failure = await store.get('any').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('STORAGE');
  });
});
