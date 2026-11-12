import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  comparePlansByUpdatedAt,
  type PlanHistoryUsage,
  type PlanRecord,
} from '../shared/plan';
import { writeJsonAtomically } from './atomic-json';
import { AppError } from './errors';
import { defaultSettingsDir } from './settings-store';

export const PLANS_FILE_NAME = 'plans.json';
export const PLANS_SCHEMA_VERSION = 1;

interface PlansFile {
  schemaVersion: number;
  plans: PlanRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageError(message: string, detail?: unknown): AppError {
  return new AppError('STORAGE', 500, message, { detail: detail ?? null });
}

export class PlanStore {
  readonly filePath: string;

  private readonly dataDir: string;
  private loadPromise: Promise<void> | null = null;
  private plans: PlanRecord[] = [];
  private bytes = 0;

  constructor(dataDir = defaultSettingsDir()) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, PLANS_FILE_NAME);
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }

    return this.loadPromise;
  }

  private async load(): Promise<void> {
    let text: string;

    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.plans = [];
        this.bytes = 0;
        return;
      }

      throw storageError('无法读取任务计划书数据文件。', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let payload: unknown;

    this.bytes = Buffer.byteLength(text, 'utf8');

    try {
      payload = JSON.parse(text);
    } catch {
      throw storageError('任务计划书数据文件已损坏，无法解析。');
    }

    if (!isRecord(payload)) {
      throw storageError('任务计划书数据文件格式不正确。');
    }

    const schemaVersion =
      typeof payload.schemaVersion === 'number' ? payload.schemaVersion : 0;

    if (schemaVersion > PLANS_SCHEMA_VERSION) {
      throw storageError('数据文件由更新版本的应用创建，请升级应用。');
    }

    if (!Array.isArray(payload.plans)) {
      throw storageError('任务计划书数据文件缺少 plans 数组。');
    }

    this.plans = payload.plans.filter(
      (plan): plan is PlanRecord =>
        isRecord(plan) && typeof plan.id === 'string' && isRecord(plan.plan),
    );
  }

  async get(id: string): Promise<PlanRecord | null> {
    await this.ensureLoaded();
    return this.plans.find((plan) => plan.id === id) ?? null;
  }

  async list(): Promise<PlanRecord[]> {
    await this.ensureLoaded();
    return [...this.plans].sort(comparePlansByUpdatedAt);
  }

  async usage(): Promise<PlanHistoryUsage> {
    await this.ensureLoaded();
    return { count: this.plans.length, bytes: this.bytes };
  }

  async create(record: PlanRecord): Promise<PlanRecord> {
    await this.ensureLoaded();
    await this.commit([record, ...this.plans]);
    return record;
  }

  async update(
    record: PlanRecord,
    options: { expectedUpdatedAt?: string } = {},
  ): Promise<PlanRecord> {
    await this.ensureLoaded();

    const index = this.plans.findIndex((plan) => plan.id === record.id);
    if (index === -1) {
      throw new AppError('NOT_FOUND', 404, '找不到该任务计划书。');
    }

    const current = this.plans[index]!;
    if (
      options.expectedUpdatedAt !== undefined &&
      current.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new AppError(
        'CONFLICT',
        409,
        '计划已被其他操作修改，请重新尝试。',
      );
    }

    const next = [...this.plans];
    next[index] = record;
    await this.commit(next);
    return record;
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();

    if (!this.plans.some((plan) => plan.id === id)) {
      throw new AppError('NOT_FOUND', 404, '找不到该任务计划书。');
    }

    await this.commit(this.plans.filter((plan) => plan.id !== id));
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    if (this.plans.length === 0) return;

    await this.commit([]);
  }

  private async commit(next: PlanRecord[]): Promise<void> {
    const previous = this.plans;
    this.plans = next;

    try {
      await this.write();
    } catch (error) {
      this.plans = previous;
      throw error;
    }
  }

  private async write(): Promise<void> {
    const payload: PlansFile = {
      schemaVersion: PLANS_SCHEMA_VERSION,
      plans: this.plans,
    };

    try {
      this.bytes = await writeJsonAtomically(this.dataDir, PLANS_FILE_NAME, payload);
    } catch (error) {
      throw storageError('无法写入任务计划书数据文件。', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
