import Fastify, { type FastifyServerOptions } from 'fastify';

import { validatePlan, type Plan, type PlanRecord } from '../shared/plan';
import { planSchema } from '../shared/plan-schema';
import { resolveCapability, validateSettingsDraft } from '../shared/settings';
import { AppError, errorEnvelope } from './errors';
import { GenerationService } from './generation';
import type { CallModel } from './llm';
import { PlanStore } from './plan-store';
import {
  testProviderConnection,
  type ProviderConnectionSettings,
  type TestConnectionResult,
} from './provider';
import { SettingsStore } from './settings-store';

export interface AppDependencies {
  settingsStore?: SettingsStore;
  planStore?: PlanStore;
  testConnection?: (settings: ProviderConnectionSettings) => Promise<TestConnectionResult>;
  callModel?: CallModel;
  sleep?: (ms: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildApp(options: FastifyServerOptions = {}, dependencies: AppDependencies = {}) {
  const app = Fastify(options);
  const settingsStore = dependencies.settingsStore ?? new SettingsStore();
  const planStore = dependencies.planStore ?? new PlanStore();
  const testConnection = dependencies.testConnection ?? testProviderConnection;
  const generation = new GenerationService({
    settingsStore,
    planStore,
    ...(dependencies.callModel ? { callModel: dependencies.callModel } : {}),
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send(errorEnvelope(error));
    }

    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      return reply
        .code(statusCode)
        .send(
          errorEnvelope(
            new AppError('INVALID_INPUT', statusCode, '请求内容格式不正确。'),
          ),
        );
    }

    request.log.error(error);
    return reply
      .code(500)
      .send(errorEnvelope(new AppError('INTERNAL', 500, '服务器内部错误。')));
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'task-layout-engine',
  }));

  app.get('/api/settings', async () => settingsStore.getPublic());

  app.put('/api/settings', async (request, reply) => {
    const validated = validateSettingsDraft(request.body);

    if (!validated.ok) {
      return reply.code(400).send({ error: validated.error });
    }

    return settingsStore.save(validated.value);
  });

  app.post('/api/settings/test', async (request, reply) => {
    const current = await settingsStore.getResolved();
    const body = isRecord(request.body) ? request.body : {};
    const apiKey =
      typeof body.apiKey === 'string' && body.apiKey.trim()
        ? body.apiKey.trim()
        : (current.apiKey ?? '');

    const validated = validateSettingsDraft({
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : current.baseUrl,
      model: typeof body.model === 'string' ? body.model : current.model,
      extraBody:
        typeof body.extraBody === 'string'
          ? body.extraBody
          : JSON.stringify(current.extraBody),
      apiKey,
      persistKey: true,
    });

    if (!validated.ok) {
      return reply.code(400).send({ error: validated.error });
    }

    if (!apiKey) {
      return reply.code(400).send({
        error: {
          code: 'MISSING_API_KEY',
          message: '请先填写 API key，或保存一个 key 后再测试连接。',
          field: 'apiKey',
        },
      });
    }

    return testConnection({
      baseUrl: validated.value.baseUrl,
      model: validated.value.model,
      apiKey,
      extraBody: JSON.parse(validated.value.extraBody) as Record<string, unknown>,
      capability: resolveCapability(validated.value.baseUrl, validated.value.model),
    });
  });

  app.post('/api/generate', async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const controller = new AbortController();
    const abortIfDisconnected = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };

    request.raw.once('aborted', abortIfDisconnected);
    reply.raw.once('close', abortIfDisconnected);

    try {
      const record = await generation.generate(body.source, {
        signal: controller.signal,
      });

      return reply.code(201).send({ record });
    } finally {
      request.raw.off('aborted', abortIfDisconnected);
      reply.raw.off('close', abortIfDisconnected);
    }
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id', async (request) => {
    const record = await planStore.get(request.params.id);

    if (!record) {
      throw new AppError('NOT_FOUND', 404, '找不到该任务计划书。');
    }

    return record;
  });

  app.put<{ Params: { id: string } }>('/api/plans/:id', async (request) => {
    const existing = await planStore.get(request.params.id);

    if (!existing) {
      throw new AppError('NOT_FOUND', 404, '找不到该任务计划书。');
    }

    const body = isRecord(request.body) ? request.body : {};
    const parsed = planSchema.safeParse(body.plan);

    if (!parsed.success) {
      throw new AppError('INVALID_INPUT', 400, '任务计划书格式不正确。', {
        detail: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if (body.title !== undefined && typeof body.title !== 'string') {
      throw new AppError('INVALID_INPUT', 400, '计划标题格式不正确。');
    }

    const title =
      typeof body.title === 'string'
        ? body.title.trim()
        : parsed.data.title.trim();

    if (title && parsed.data.title.trim() !== title) {
      throw new AppError('INVALID_INPUT', 400, '计划标题与计划内容不一致。', {
        detail: { path: 'title', message: '请求标题必须与计划标题相同。' },
      });
    }

    const plan: Plan = { ...parsed.data, title };
    const issues = validatePlan(plan);

    if (issues.length > 0) {
      const first = issues[0]!;
      throw new AppError('INTEGRITY', 422, `计划不完整：${first.message}`, {
        detail: issues,
        nodePath: first.path,
      });
    }

    const updated: PlanRecord = {
      ...existing,
      title,
      plan,
      updatedAt: new Date().toISOString(),
    };

    return planStore.update(updated);
  });

  return app;
}
