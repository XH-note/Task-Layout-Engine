import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectLeaves, type PlanRecord } from '../shared/plan';
import { buildApp } from './app';
import { AppError } from './errors';
import type { CallModel, ChatRequest, ChatResult } from './llm';
import { PlanStore } from './plan-store';
import { SettingsStore } from './settings-store';
import {
  cloneWirePlan,
  findWireNode,
  validWireJson,
} from '../test-support/wire-plan';

const SOURCE = '我们要把旧系统迁移到新平台，需要一份可执行计划。';

let dataDir: string;
let app: FastifyInstance | null = null;

function modelReply(
  content: string,
  finishReason = 'stop',
  usage = { promptTokens: 100, completionTokens: 500 },
): ChatResult {
  return { content, finishReason, usage, raw: { choices: [] } };
}

function plansFile(): string {
  return path.join(dataDir, 'plans.json');
}

async function buildTestApp(
  callModel: CallModel,
  options: { withKey?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ app: FastifyInstance; planStore: PlanStore }> {
  const settingsStore = new SettingsStore(dataDir);

  await settingsStore.save({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    extraBody: '{}',
    ...(options.withKey === false ? {} : { apiKey: 'test-key' }),
    persistKey: true,
  });

  const planStore = new PlanStore(dataDir);
  const instance = buildApp(
    { logger: false },
    {
      settingsStore,
      planStore,
      callModel,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
  );

  app = instance;
  await instance.ready();
  return { app: instance, planStore };
}

function postGenerate(source: string) {
  return app!.inject({
    method: 'POST',
    url: '/api/generate',
    payload: { source },
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-generate-'));
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('POST /api/generate', () => {
  it('generates, normalizes and persists a plan, then serves it by id', async () => {
    const calls: ChatRequest[] = [];
    const callModel: CallModel = async (_settings, request) => {
      calls.push(request);
      return modelReply(validWireJson());
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(201);
    const { record } = response.json() as { record: PlanRecord };
    expect(record).toMatchObject({
      title: '系统迁移计划',
      source: SOURCE,
      model: 'deepseek-flash',
      usage: { promptTokens: 100, completionTokens: 500 },
    });
    expect(record.plan.nodes).toHaveLength(3);
    expect(record.plan.meta).toMatchObject({
      source: 'paste',
      model: 'deepseek-flash',
      version: '1',
    });

    const leaves = collectLeaves(record.plan.nodes);
    expect(leaves).toHaveLength(12);
    expect(leaves.every((leaf) => Boolean(leaf.acceptance))).toBe(true);

    const leafIds = new Set(leaves.map((leaf) => leaf.id));
    for (const leaf of leaves) {
      for (const dependency of leaf.deps ?? []) {
        expect(leafIds.has(dependency)).toBe(true);
        expect(dependency).not.toBe(leaf.id);
      }
    }

    expect(existsSync(plansFile())).toBe(true);
    expect(calls).toHaveLength(1);

    const fetched = await app!.inject({
      method: 'GET',
      url: `/api/plans/${record.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(record);

    const reopened = new PlanStore(dataDir);
    await expect(reopened.get(record.id)).resolves.toEqual(record);
  });

  it('rejects empty input without calling the model or writing data', async () => {
    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      return modelReply(validWireJson());
    };
    await buildTestApp(callModel);

    const response = await postGenerate('   \n  ');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', retryable: false },
    });
    expect(calls).toBe(0);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('rejects sources over 20,000 code points', async () => {
    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      return modelReply(validWireJson());
    };
    await buildTestApp(callModel);

    const response = await postGenerate('a'.repeat(20_001));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    });
    expect(calls).toBe(0);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('fails truncated output without retrying or persisting', async () => {
    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      return modelReply(validWireJson().slice(0, 200), 'length');
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'OUTPUT_TRUNCATED', retryable: true },
    });
    expect(calls).toBe(1);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('fails all-whitespace output as truncated without retrying or persisting', async () => {
    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      return modelReply('   \n\t ');
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'OUTPUT_TRUNCATED' },
    });
    expect(calls).toBe(1);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('retries once with field paths after a wire-schema failure', async () => {
    const broken = cloneWirePlan();
    const leaf = findWireNode(broken, 'n2');
    expect(leaf).toBeDefined();
    delete (leaf as { acceptance?: string }).acceptance;

    const calls: ChatRequest[] = [];
    const callModel: CallModel = async (_settings, request) => {
      calls.push(request);
      return modelReply(calls.length === 1 ? JSON.stringify(broken) : validWireJson());
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(201);
    expect(calls).toHaveLength(2);
    const { record } = response.json() as { record: PlanRecord };
    expect(record.usage).toEqual({
      promptTokens: 200,
      completionTokens: 1000,
    });
    const repairPrompt = calls[1]?.messages.at(-1)?.content ?? '';
    expect(repairPrompt).toContain('nodes[0].children[0].acceptance');
  });

  it('retries once after a dependency cycle and reports semantic paths', async () => {
    const broken = cloneWirePlan();
    findWireNode(broken, 'n2')!.deps = ['n3'];
    findWireNode(broken, 'n3')!.deps = ['n2'];

    const calls: ChatRequest[] = [];
    const callModel: CallModel = async (_settings, request) => {
      calls.push(request);
      return modelReply(calls.length === 1 ? JSON.stringify(broken) : validWireJson());
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(201);
    expect(calls[1]?.messages.at(-1)?.content).toContain('依赖成环');
  });

  it('rejects a plan with fewer than 12 leaves after both attempts', async () => {
    const tooSmall = cloneWirePlan();
    tooSmall.nodes[0]!.children = tooSmall.nodes[0]!.children.slice(0, 2);

    const calls: ChatRequest[] = [];
    const callModel: CallModel = async (_settings, request) => {
      calls.push(request);
      return modelReply(JSON.stringify(tooSmall));
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      error: { code: string; detail: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe('INTEGRITY');
    expect(body.error.detail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('12–20') }),
      ]),
    );
    expect(calls).toHaveLength(2);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('rejects unrepairable wire output after both attempts', async () => {
    const broken = cloneWirePlan();
    delete (findWireNode(broken, 'n2') as { acceptance?: string }).acceptance;
    const invalidJson = JSON.stringify(broken);

    const calls: ChatRequest[] = [];
    const callModel: CallModel = async (_settings, request) => {
      calls.push(request);
      return modelReply(invalidJson);
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      error: { code: string; detail: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe('OUTPUT_INVALID');
    expect(body.error.detail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'nodes[0].children[0].acceptance',
        }),
      ]),
    );
    expect(calls).toHaveLength(2);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('rejects leaf hours outside 0.5–8 after both attempts', async () => {
    const broken = cloneWirePlan();
    findWireNode(broken, 'n2')!.estimateHours = 9;

    const callModel: CallModel = async () => modelReply(JSON.stringify(broken));
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      error: { code: string; detail: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe('INTEGRITY');
    expect(body.error.detail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'nodes[0].children[0].estimateHours',
          message: expect.stringContaining('0.5'),
        }),
      ]),
    );
    expect(existsSync(plansFile())).toBe(false);
  });

  it('rejects malformed JSON request bodies with the error envelope', async () => {
    await buildTestApp(async () => modelReply(validWireJson()));

    const response = await app!.inject({
      method: 'POST',
      url: '/api/generate',
      headers: { 'content-type': 'application/json' },
      payload: '{"source":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', retryable: false },
    });
  });

  it('returns 409 BUSY when a generation is already in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    const callModel: CallModel = async () => {
      started();
      await gate;
      return modelReply(validWireJson());
    };
    await buildTestApp(callModel);

    const first = postGenerate(SOURCE);
    await startedPromise;

    const second = await postGenerate(SOURCE);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: 'BUSY', retryable: true },
    });

    release();
    await expect(first).resolves.toMatchObject({ statusCode: 201 });
  });

  it.each([
    ['PROVIDER_NETWORK', 502, 500],
    ['PROVIDER_RATE_LIMIT', 502, 1_000],
    ['PROVIDER_SERVER', 502, 500],
  ] as const)(
    'automatically retries %s once before succeeding',
    async (code, status, delay) => {
      let calls = 0;
      const sleeps: number[] = [];
      const callModel: CallModel = async () => {
        calls += 1;
        if (calls === 1) {
          throw new AppError(code, status, '暂时失败。', { retryable: true });
        }
        return modelReply(validWireJson());
      };
      await buildTestApp(callModel, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      const response = await postGenerate(SOURCE);

      expect(response.statusCode).toBe(201);
      expect(calls).toBe(2);
      expect(sleeps).toEqual([delay]);
    },
  );

  it('does not retry provider errors that are not transient', async () => {
    for (const [code, status] of [
      ['PROVIDER_AUTH', 502],
      ['PROVIDER_BAD_REQUEST', 502],
      ['PROVIDER_TIMEOUT', 504],
    ] as const) {
      let calls = 0;
      const sleeps: number[] = [];
      const callModel: CallModel = async () => {
        calls += 1;
        throw new AppError(code, status, '不可重试。', { retryable: false });
      };
      if (app) await app.close();
      await buildTestApp(callModel, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      const response = await postGenerate(SOURCE);

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
      expect(existsSync(plansFile())).toBe(false);
    }
  });

  it('uses one automatic retry for the whole generation, including repair', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const callModel: CallModel = async () => {
      calls += 1;
      if (calls === 3) {
        throw new AppError('PROVIDER_NETWORK', 502, '网络失败。', { retryable: true });
      }
      if (calls === 1) {
        throw new AppError('PROVIDER_NETWORK', 502, '网络失败。', { retryable: true });
      }
      return modelReply('这不是 JSON。');
    };
    await buildTestApp(callModel, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'PROVIDER_NETWORK' } });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500]);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('does not persist a record when the retry also fails', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const callModel: CallModel = async () => {
      calls += 1;
      throw new AppError('PROVIDER_NETWORK', 502, '网络失败。', { retryable: true });
    };
    await buildTestApp(callModel, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'PROVIDER_NETWORK' } });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(existsSync(plansFile())).toBe(false);
  });

  it('cancels the in-flight generation when the client disconnects', async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const callModel: CallModel = async (_settings, request) =>
      new Promise<ChatResult>((_resolve, reject) => {
        markStarted();
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (request.signal?.aborted) {
          abort();
          return;
        }
        request.signal?.addEventListener('abort', abort, { once: true });
      });
    const { app, planStore } = await buildTestApp(callModel);
    const create = vi.spyOn(planStore, 'create');
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('测试服务器没有监听端口。');
    }

    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: SOURCE }),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await started;
    controller.abort();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(create).not.toHaveBeenCalled();
  });

  it('does not abort a normal request when the response closes', async () => {
    const callModel: CallModel = async () => modelReply(validWireJson());
    const { app, planStore } = await buildTestApp(callModel);
    const create = vi.spyOn(planStore, 'create');
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('测试服务器没有监听端口。');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: SOURCE }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      record: { plan: { title: expect.any(String) } },
    });
  });

  it('requires an API key before calling the model', async () => {
    let calls = 0;
    const callModel: CallModel = async () => {
      calls += 1;
      return modelReply(validWireJson());
    };
    await buildTestApp(callModel, { withKey: false });

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(calls).toBe(0);
  });

  it('maps provider failures to the error envelope', async () => {
    const callModel: CallModel = async () => {
      throw new AppError('PROVIDER_AUTH', 502, '模型服务拒绝了认证，请检查 API Key。');
    };
    await buildTestApp(callModel);

    const response = await postGenerate(SOURCE);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: 'PROVIDER_AUTH',
        message: '模型服务拒绝了认证，请检查 API Key。',
        detail: null,
        retryable: false,
      },
    });
  });
});

describe('GET /api/plans/:id', () => {
  it('returns 404 NOT_FOUND for unknown ids', async () => {
    const callModel: CallModel = async () => modelReply(validWireJson());
    await buildTestApp(callModel);

    const response = await app!.inject({
      method: 'GET',
      url: '/api/plans/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', retryable: false },
    });
  });
});
