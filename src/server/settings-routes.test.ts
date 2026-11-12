import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDependencies } from './app';
import type { ProviderConnectionSettings, TestConnectionResult } from './provider';
import { SETTINGS_FILE_NAME, SettingsStore } from './settings-store';

const temporaryDirectories: string[] = [];
const apps: FastifyInstance[] = [];

async function setup(dependencies: Omit<AppDependencies, 'settingsStore'> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-routes-'));
  temporaryDirectories.push(directory);

  const settingsStore = new SettingsStore(directory);
  const app = buildApp({}, { settingsStore, ...dependencies });
  apps.push(app);

  return { app, directory, settingsStore };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('settings routes', () => {
  it('returns public settings without exposing a key', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/api/settings',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasKey: false,
      keyMask: null,
      keySource: 'none',
    });
  });

  it('rejects invalid extra body JSON and points at the location', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        extraBody: '{"a": }',
        persistKey: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_EXTRA_BODY',
        field: 'extraBody',
        line: 1,
      },
    });
    expect(response.json().error.column).toBeGreaterThan(0);
  });

  it('saves a persisted key and only returns its mask', async () => {
    const { app, directory } = await setup();
    const apiKey = 'sk-1234567890abcd';

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        extraBody: '{"thinking":{"type":"enabled"}}',
        apiKey,
        persistKey: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasKey: true,
      keyMask: 'sk-…abcd',
      keySource: 'saved',
    });
    expect(JSON.stringify(response.json())).not.toContain(apiKey);

    const raw = await fs.readFile(path.join(directory, SETTINGS_FILE_NAME), 'utf8');
    expect(raw).toContain(apiKey);
  });

  it('does not write a session-only key to disk', async () => {
    const { app, directory } = await setup();
    const apiKey = 'sk-1234567890abcd';

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        extraBody: '{}',
        apiKey,
        persistKey: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasKey: true,
      keySource: 'session',
    });

    const raw = await fs.readFile(path.join(directory, SETTINGS_FILE_NAME), 'utf8');
    expect(raw).not.toContain(apiKey);
  });

  it('tests an unsaved connection without persisting the key', async () => {
    const testConnection = vi.fn(
      async (settings: ProviderConnectionSettings): Promise<TestConnectionResult> => ({
        ok: true,
        capability: settings.capability,
        latencyMs: 42,
        status: 200,
      }),
    );
    const { app } = await setup({ testConnection });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test',
      payload: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        extraBody: '{}',
        apiKey: 'sk-test-9999',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      capability: 'json_object_prompted',
      latencyMs: 42,
      status: 200,
    });
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(testConnection.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'sk-test-9999',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    });

    const settings = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.json()).toMatchObject({ hasKey: false });
  });

  it('returns a readable provider failure without a 5xx status', async () => {
    const testConnection = vi.fn(
      async (): Promise<TestConnectionResult> => ({
        ok: false,
        capability: 'json_object_prompted',
        latencyMs: 12,
        status: 401,
        code: 'AUTH_FAILED',
        message: '鉴权失败（401）：API key 无效或不再有效。',
      }),
    );
    const { app } = await setup({ testConnection });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test',
      payload: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        extraBody: '{}',
        apiKey: 'sk-test-9999',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      code: 'AUTH_FAILED',
      message: expect.stringContaining('API key'),
    });
  });

  it('requires a key before testing a connection', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test',
      payload: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        extraBody: '{}',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'MISSING_API_KEY',
        field: 'apiKey',
      },
    });
  });
});
