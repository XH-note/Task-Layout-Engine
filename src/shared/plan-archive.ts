import { validatePlan, type PlanRecord } from './plan';
import { planRecordSchema } from './plan-schema';

export const PLAN_ARCHIVE_VERSION = 1;

export interface PlanArchive {
  schemaVersion: number;
  plans: unknown[];
}

export type PlanArchiveMigration = (plans: unknown[]) => unknown[];

export type PlanArchiveCheck =
  | { ok: true; archive: PlanArchive }
  | { ok: false; code: 'INVALID_ARCHIVE' | 'VERSION_TOO_NEW'; message: string };

const INVALID_ARCHIVE_MESSAGE =
  '导入文件格式不正确，请选择由本应用导出的 JSON 备份文件。';
const VERSION_TOO_NEW_MESSAGE =
  '导入文件由更新版本的应用创建，请升级应用后再试。';

/**
 * 旧版本备份的迁移链：键是源版本，函数把该版本的 plans 数组升级到下一版本。
 * v0 是尚未携带 schemaVersion 的裸数组备份。
 */
const ARCHIVE_MIGRATIONS: Record<number, PlanArchiveMigration> = {
  0: (plans) => plans,
};

export function migratePlanArchive(input: unknown): PlanArchiveCheck {
  const parsed = parseArchiveShape(input);

  if (!parsed) {
    return { ok: false, code: 'INVALID_ARCHIVE', message: INVALID_ARCHIVE_MESSAGE };
  }

  if (parsed.schemaVersion > PLAN_ARCHIVE_VERSION) {
    return { ok: false, code: 'VERSION_TOO_NEW', message: VERSION_TOO_NEW_MESSAGE };
  }

  let version = parsed.schemaVersion;
  let plans = parsed.plans;

  while (version < PLAN_ARCHIVE_VERSION) {
    const migrate = ARCHIVE_MIGRATIONS[version];

    if (!migrate) {
      return {
        ok: false,
        code: 'INVALID_ARCHIVE',
        message: '导入文件版本过低，缺少可用的数据迁移。',
      };
    }

    plans = migrate(plans);
    version += 1;
  }

  if (!Array.isArray(plans)) {
    return { ok: false, code: 'INVALID_ARCHIVE', message: INVALID_ARCHIVE_MESSAGE };
  }

  return { ok: true, archive: { schemaVersion: PLAN_ARCHIVE_VERSION, plans } };
}

function parseArchiveShape(
  input: unknown,
): { schemaVersion: number; plans: unknown[] } | null {
  if (Array.isArray(input)) {
    return { schemaVersion: 0, plans: input };
  }

  if (typeof input !== 'object' || input === null) return null;

  const candidate = input as { schemaVersion?: unknown; plans?: unknown };
  const version = candidate.schemaVersion;

  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    !Array.isArray(candidate.plans)
  ) {
    return null;
  }

  return { schemaVersion: version, plans: candidate.plans };
}

export interface PlanImportSkip {
  index: number;
  title: string;
  message: string;
}

export interface PlanImportResult {
  records: PlanRecord[];
  skipped: PlanImportSkip[];
}

export interface PlanImportOptions {
  createId?: () => string;
}

function defaultRecordId(): string {
  return globalThis.crypto.randomUUID();
}

function hintTitle(raw: unknown, index: number): string {
  if (typeof raw === 'object' && raw !== null) {
    const candidate = raw as { title?: unknown; plan?: { title?: unknown } };

    if (typeof candidate.title === 'string' && candidate.title.trim()) {
      return candidate.title.trim();
    }

    if (
      typeof candidate.plan?.title === 'string' &&
      candidate.plan.title.trim()
    ) {
      return candidate.plan.title.trim();
    }
  }

  return `第 ${index + 1} 条`;
}

export function preparePlanImport(
  rawPlans: unknown[],
  existingIds: Iterable<string>,
  options: PlanImportOptions = {},
): PlanImportResult {
  const createId = options.createId ?? defaultRecordId;
  const usedIds = new Set(existingIds);
  const records: PlanRecord[] = [];
  const skipped: PlanImportSkip[] = [];

  rawPlans.forEach((raw, index) => {
    const title = hintTitle(raw, index);
    const parsed = planRecordSchema.safeParse(raw);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue && issue.path.length > 0 ? issue.path.join('.') : '记录';

      skipped.push({
        index,
        title,
        message: `记录结构不合法：${at}`,
      });
      return;
    }

    const issues = validatePlan(parsed.data.plan);

    if (issues.length > 0) {
      skipped.push({
        index,
        title,
        message: `计划校验未通过：${issues[0].message}`,
      });
      return;
    }

    const planTitle = parsed.data.plan.title.trim();
    let id = parsed.data.id;

    if (usedIds.has(id)) {
      do {
        id = createId();
      } while (usedIds.has(id));
    }

    usedIds.add(id);
    records.push({
      ...parsed.data,
      id,
      title: planTitle,
      plan: { ...parsed.data.plan, title: planTitle },
    });
  });

  return { records, skipped };
}
