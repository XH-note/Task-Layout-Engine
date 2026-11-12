import Fastify, { type FastifyServerOptions } from 'fastify';

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
    const record = await generation.generate(body.source);

    return reply.code(201).send({ record });
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id', async (request) => {
    const record = await planStore.get(request.params.id);

    if (!record) {
      throw new AppError('NOT_FOUND', 404, '找不到该任务计划书。');
    }

    return record;
  });

  return app;
}
