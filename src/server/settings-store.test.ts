import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SETTINGS_FILE_NAME, SettingsStore } from './settings-store';

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{ directory: string; store: SettingsStore }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-layout-settings-'));
  temporaryDirectories.push(directory);
  return { directory, store: new SettingsStore(directory) };
}

const draft = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  extraBody: '{"thinking":{"type":"enabled"}}',
  apiKey: 'sk-1234567890abcd',
  persistKey: true,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('SettingsStore', () => {
  it('starts without a key', async () => {
    const { store } = await createStore();

    await expect(store.getPublic()).resolves.toMatchObject({
      hasKey: false,
      keyMask: null,
      keySource: 'none',
    });
  });

  it('persists a key in plaintext and masks it in public settings', async () => {
    const { directory, store } = await createStore();

    const saved = await store.save(draft);
    expect(saved).toMatchObject({
      hasKey: true,
      keyMask: 'sk-…abcd',
      keySource: 'saved',
    });

    const raw = await fs.readFile(path.join(directory, SETTINGS_FILE_NAME), 'utf8');
    expect(raw).toContain(draft.apiKey);
    expect(raw).toContain('"schemaVersion": 1');

    const reloaded = new SettingsStore(directory);
    const publicSettings = await reloaded.getPublic();
    expect(publicSettings.hasKey).toBe(true);
    expect(publicSettings.keyMask).toBe('sk-…abcd');
    expect(publicSettings.keySource).toBe('saved');
    await expect(reloaded.getResolved()).resolves.toMatchObject({
      apiKey: draft.apiKey,
    });
  });

  it('keeps a session-only key in memory and out of the settings file', async () => {
    const { directory, store } = await createStore();

    await store.save({ ...draft, persistKey: false });

    expect(await store.getPublic()).toMatchObject({
      hasKey: true,
      keySource: 'session',
    });

    const raw = await fs.readFile(path.join(directory, SETTINGS_FILE_NAME), 'utf8');
    expect(raw).not.toContain(draft.apiKey);

    const reloaded = new SettingsStore(directory);
    expect(await reloaded.getPublic()).toMatchObject({
      hasKey: false,
      keySource: 'none',
    });
  });

  it('can move a saved key into session-only mode', async () => {
    const { directory, store } = await createStore();
    await store.save(draft);

    await store.save({
      ...draft,
      apiKey: undefined,
      persistKey: false,
    });

    expect(await store.getPublic()).toMatchObject({
      hasKey: true,
      keySource: 'session',
    });

    const raw = await fs.readFile(path.join(directory, SETTINGS_FILE_NAME), 'utf8');
    expect(raw).not.toContain(draft.apiKey);
  });
});
