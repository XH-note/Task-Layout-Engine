import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  maskKey,
  parseExtraBody,
  resolveCapability,
  validateBaseUrl,
  type ExtraBody,
  type PublicSettings,
  type SettingsDraft,
} from '../shared/settings';
import { writeJsonAtomically } from './atomic-json';

export const SETTINGS_FILE_NAME = 'settings.json';

interface StoredSettings {
  baseUrl: string;
  model: string;
  extraBody: ExtraBody;
  apiKey?: string;
}

export interface ResolvedSettings extends PublicSettings {
  apiKey: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultSettingsDir(): string {
  if (process.env.TASK_LAYOUT_DATA_DIR) return process.env.TASK_LAYOUT_DATA_DIR;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'task-layout');
  return path.join(os.homedir(), '.config', 'task-layout');
}

export class SettingsStore {
  readonly filePath: string;

  private readonly dataDir: string;
  private loadPromise: Promise<void> | null = null;
  private saved: StoredSettings = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    extraBody: {},
  };
  private sessionApiKey: string | null = null;

  constructor(dataDir = defaultSettingsDir()) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, SETTINGS_FILE_NAME);
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }

    return this.loadPromise;
  }

  private async load(): Promise<void> {
    let raw: string;

    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isRecord(parsed)) return;

    const baseUrl = validateBaseUrl(typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '');
    const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    const extraBody = isRecord(parsed.extraBody) ? parsed.extraBody : {};
    const extraBodyCheck = parseExtraBody(JSON.stringify(extraBody));

    if (!baseUrl.ok || !model || !extraBodyCheck.ok) return;

    this.saved = {
      baseUrl: baseUrl.value,
      model,
      extraBody: extraBodyCheck.value,
      ...(typeof parsed.apiKey === 'string' && parsed.apiKey.trim()
        ? { apiKey: parsed.apiKey.trim() }
        : {}),
    };
  }

  private activeKey(): string | null {
    return this.sessionApiKey ?? this.saved.apiKey ?? null;
  }

  private toPublic(): PublicSettings {
    const apiKey = this.activeKey();
    const keySource: PublicSettings['keySource'] = this.sessionApiKey
      ? 'session'
      : this.saved.apiKey
        ? 'saved'
        : 'none';

    return {
      baseUrl: this.saved.baseUrl,
      model: this.saved.model,
      extraBody: this.saved.extraBody,
      hasKey: Boolean(apiKey),
      keyMask: apiKey ? maskKey(apiKey) : null,
      keySource,
      capability: resolveCapability(this.saved.baseUrl, this.saved.model),
    };
  }

  async getPublic(): Promise<PublicSettings> {
    await this.ensureLoaded();
    return this.toPublic();
  }

  async getResolved(): Promise<ResolvedSettings> {
    await this.ensureLoaded();
    return {
      ...this.toPublic(),
      apiKey: this.activeKey(),
    };
  }

  async save(draft: SettingsDraft): Promise<PublicSettings> {
    await this.ensureLoaded();

    const extraBody = parseExtraBody(draft.extraBody);
    if (!extraBody.ok) throw new Error(extraBody.error.message);

    const nextSaved: StoredSettings = {
      ...this.saved,
      baseUrl: draft.baseUrl,
      model: draft.model,
      extraBody: extraBody.value,
    };

    const providedKey = draft.apiKey?.trim() || null;
    const activeKey = providedKey ?? this.activeKey();

    if (draft.persistKey) {
      if (activeKey) {
        nextSaved.apiKey = activeKey;
      } else {
        delete nextSaved.apiKey;
      }
      this.sessionApiKey = null;
    } else {
      delete nextSaved.apiKey;
      this.sessionApiKey = activeKey;
    }

    await this.write(nextSaved);
    this.saved = nextSaved;

    return this.toPublic();
  }

  private async write(settings: StoredSettings): Promise<void> {
    const payload = {
      schemaVersion: 1,
      baseUrl: settings.baseUrl,
      model: settings.model,
      extraBody: settings.extraBody,
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    };

    await writeJsonAtomically(this.dataDir, SETTINGS_FILE_NAME, payload);
  }
}
