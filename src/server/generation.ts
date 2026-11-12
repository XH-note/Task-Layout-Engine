import { randomUUID } from 'node:crypto';

import {
  buildLeafRegenerationPrompt,
  buildRepairPrompt,
  buildUserPrompt,
  LEAF_REGENERATION_SYSTEM_PROMPT,
  TASK_PLAN_SYSTEM_PROMPT,
} from '../shared/generation';
import { countCodePoints, MAX_SOURCE_CODE_POINTS } from '../shared/source';
import {
  applyLeafRegeneration,
  collectLeafOptions,
  findPlanNodePath,
  isGroup,
  normalizeWirePlan,
  validatePlan,
  type Plan,
  type PlanIssue,
  type PlanRecord,
  type RegeneratedLeafFields,
  type RegenerateLeafResponse,
} from '../shared/plan';
import {
  parseWireNodeContent,
  parseWirePlanContent,
  type WireNode,
} from '../shared/wire';
import { AppError, cancelledError } from './errors';
import {
  callChatCompletion,
  GENERATION_TIMEOUT_MS,
  type CallModel,
  type ChatMessage,
  type ChatResult,
  type ChatUsage,
} from './llm';
import type { PlanStore } from './plan-store';
import type { ProviderConnectionSettings } from './provider';
import type { ResolvedSettings, SettingsStore } from './settings-store';

type EvaluateResult =
  | { ok: true; plan: Plan; raw: unknown }
  | { ok: false; kind: 'parse' | 'integrity'; issues: PlanIssue[] };

type LeafEvaluateResult =
  | { ok: true; plan: Plan; warning?: string }
  | { ok: false; kind: 'parse' | 'integrity'; issues: PlanIssue[] };

export interface GenerationDependencies {
  settingsStore: Pick<SettingsStore, 'getResolved'>;
  planStore: Pick<PlanStore, 'create' | 'get' | 'update'>;
  callModel?: CallModel;
  now?: () => Date;
  createId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const AUTO_RETRY_DELAY_MS: Record<string, number> = {
  PROVIDER_NETWORK: 500,
  PROVIDER_RATE_LIMIT: 1_000,
  PROVIDER_SERVER: 500,
};

export interface GenerateOptions {
  signal?: AbortSignal;
}

export type RegenerateLeafOptions = GenerateOptions;

interface RetryState {
  autoRetried: boolean;
}

function invalidInput(message: string, detail: unknown = null): AppError {
  return new AppError('INVALID_INPUT', 400, message, { detail });
}

function toProviderSettings(settings: ResolvedSettings): ProviderConnectionSettings {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey as string,
    extraBody: settings.extraBody,
    capability: settings.capability,
  };
}

export class GenerationService {
  private readonly settingsStore: Pick<SettingsStore, 'getResolved'>;
  private readonly planStore: Pick<PlanStore, 'create' | 'get' | 'update'>;
  private readonly callModel: CallModel;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private busy = false;

  constructor(dependencies: GenerationDependencies) {
    this.settingsStore = dependencies.settingsStore;
    this.planStore = dependencies.planStore;
    this.callModel = dependencies.callModel ?? callChatCompletion;
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? (() => randomUUID());
    this.sleep =
      dependencies.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async generate(rawSource: unknown, options: GenerateOptions = {}): Promise<PlanRecord> {
    const source = this.validateSource(rawSource);
    this.throwIfCancelled(options.signal);

    return this.runExclusive(() => this.run(source, options.signal));
  }

  async regenerateLeaf(
    planId: string,
    nodeId: string,
    options: RegenerateLeafOptions = {},
  ): Promise<RegenerateLeafResponse> {
    this.throwIfCancelled(options.signal);

    return this.runExclusive(() => this.runLeafRegeneration(planId, nodeId, options.signal));
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new AppError('BUSY', 409, '已有生成请求正在进行，请稍后再试。', {
        retryable: true,
      });
    }

    this.busy = true;

    try {
      return await task();
    } finally {
      this.busy = false;
    }
  }

  private validateSource(rawSource: unknown): string {
    if (typeof rawSource !== 'string') {
      throw invalidInput('source 必须是字符串。');
    }

    if (rawSource.trim() === '') {
      throw invalidInput('粘贴内容不能为空。');
    }

    const codePoints = countCodePoints(rawSource);
    if (codePoints > MAX_SOURCE_CODE_POINTS) {
      throw invalidInput(
        `粘贴内容超过 ${MAX_SOURCE_CODE_POINTS} 个字符，请精简后再生成。`,
        { codePoints, limit: MAX_SOURCE_CODE_POINTS },
      );
    }

    return rawSource;
  }

  private async run(source: string, signal?: AbortSignal): Promise<PlanRecord> {
    const resolved = await this.settingsStore.getResolved();
    this.throwIfCancelled(signal);

    if (!resolved.apiKey) {
      throw invalidInput('尚未配置 API Key，请先在设置中填写并保存。');
    }

    const settings = toProviderSettings(resolved);
    const messages: ChatMessage[] = [
      { role: 'system', content: TASK_PLAN_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(source) },
    ];

    const retryState: RetryState = { autoRetried: false };
    let response = await this.invokeModel(settings, messages, signal, retryState);
    this.assertUsable(response.content, response.finishReason);

    let usage = response.usage;
    let outcome = this.parseAndValidateOutput(response.content, settings);

    if (!outcome.ok) {
      this.throwIfCancelled(signal);
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: buildRepairPrompt(outcome.issues) });

      response = await this.invokeModel(settings, messages, signal, retryState);
      this.assertUsable(response.content, response.finishReason);
      usage = mergeUsage(usage, response.usage);
      outcome = this.parseAndValidateOutput(response.content, settings);

      if (!outcome.ok) {
        const code = outcome.kind === 'parse' ? 'OUTPUT_INVALID' : 'INTEGRITY';
        throw new AppError(code, 422, '模型两次输出都未通过任务计划书校验。', {
          detail: outcome.issues,
        });
      }
    }

    this.throwIfCancelled(signal);

    const generatedAt = this.now().toISOString();
    const record: PlanRecord = {
      id: this.createId(),
      createdAt: generatedAt,
      updatedAt: generatedAt,
      title: outcome.plan.title,
      plan: outcome.plan,
      source,
      model: resolved.model,
      usage,
      raw: outcome.raw,
    };

    return this.planStore.create(record);
  }

  private async runLeafRegeneration(
    planId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<RegenerateLeafResponse> {
    const record = await this.planStore.get(planId);
    if (!record) {
      throw new AppError('NOT_FOUND', 404, '找不到该任务计划书。');
    }

    const path = findPlanNodePath(record.plan.nodes, nodeId);
    const node = path?.[path.length - 1];
    if (!path || !node) {
      throw new AppError('NOT_FOUND', 404, '找不到该任务节点。');
    }

    if (isGroup(node)) {
      throw new AppError('INVALID_INPUT', 400, '只能重新生成叶子任务。');
    }

    const resolved = await this.settingsStore.getResolved();
    this.throwIfCancelled(signal);

    if (!resolved.apiKey) {
      throw invalidInput('尚未配置 API Key，请先在设置中填写并保存。');
    }

    const settings = toProviderSettings(resolved);
    const allLeafOptions = collectLeafOptions(record.plan.nodes);
    const leafOptions = allLeafOptions.filter((option) => option.id !== node.id);
    const dependencies = (node.deps ?? []).map(
      (dependencyId) =>
        allLeafOptions.find((option) => option.id === dependencyId)?.title ??
        dependencyId,
    );
    const parent = path[path.length - 2];
    const siblings = (parent?.children ?? [])
      .filter((sibling) => sibling.id !== node.id)
      .map((sibling) => sibling.title);

    const messages: ChatMessage[] = [
      { role: 'system', content: LEAF_REGENERATION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildLeafRegenerationPrompt({
          planTitle: record.plan.title,
          goal: record.plan.goal,
          stagePath: path.slice(0, -1).map((item) => item.title),
          node,
          siblings,
          dependencies,
          leafOptions,
        }),
      },
    ];

    const retryState: RetryState = { autoRetried: false };
    let response = await this.invokeModel(settings, messages, signal, retryState);
    this.assertUsable(response.content, response.finishReason);

    let usage = response.usage;
    let outcome = this.evaluateLeafOutput(response.content, record.plan, node.id);

    if (!outcome.ok) {
      this.throwIfCancelled(signal);
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: buildRepairPrompt(outcome.issues) });

      response = await this.invokeModel(settings, messages, signal, retryState);
      this.assertUsable(response.content, response.finishReason);
      usage = mergeUsage(usage, response.usage);
      outcome = this.evaluateLeafOutput(response.content, record.plan, node.id);

      if (!outcome.ok) {
        const code = outcome.kind === 'parse' ? 'OUTPUT_INVALID' : 'INTEGRITY';
        throw new AppError(code, 422, '模型两次输出都未通过叶子任务校验。', {
          retryable: true,
          detail: outcome.issues,
        });
      }
    }

    this.throwIfCancelled(signal);

    const updated: PlanRecord = {
      ...record,
      title: outcome.plan.title,
      plan: outcome.plan,
      updatedAt: this.now().toISOString(),
      usage,
    };

    const saved = await this.planStore.update(updated, {
      expectedUpdatedAt: record.updatedAt,
    });

    return {
      record: saved,
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    };
  }

  private evaluateLeafOutput(
    content: string,
    plan: Plan,
    nodeId: string,
  ): LeafEvaluateResult {
    const parsed = parseWireNodeContent(content);

    if (!parsed.ok) {
      return { ok: false, kind: 'parse', issues: parsed.issues };
    }

    const applied = applyLeafRegeneration(plan, nodeId, leafFieldsFromWire(parsed.wire));

    if (applied.issues.length > 0) {
      return { ok: false, kind: 'integrity', issues: applied.issues };
    }

    return {
      ok: true,
      plan: applied.plan,
      ...(applied.depsKept
        ? { warning: '新结果的依赖不合法，已保留原依赖。' }
        : {}),
    };
  }

  private async invokeModel(
    settings: ProviderConnectionSettings,
    messages: ChatMessage[],
    signal: AbortSignal | undefined,
    retryState: RetryState,
  ): Promise<ChatResult> {
    for (;;) {
      this.throwIfCancelled(signal);

      try {
        const result = await this.callModel(settings, {
          messages,
          timeoutMs: GENERATION_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
        this.throwIfCancelled(signal);
        return result;
      } catch (error) {
        this.throwIfCancelled(signal);

        const delay = autoRetryDelay(error);
        if (retryState.autoRetried || delay === null) {
          throw error;
        }

        retryState.autoRetried = true;
        await this.sleep(delay);
        this.throwIfCancelled(signal);
      }
    }
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw cancelledError();
    }
  }

  private assertUsable(content: string, finishReason: string): void {
    if (finishReason === 'length') {
      throw new AppError(
        'OUTPUT_TRUNCATED',
        422,
        '模型输出因长度限制被截断，请缩短粘贴内容后重试。',
        { retryable: true, detail: { finishReason } },
      );
    }

    if (content.trim() === '') {
      throw new AppError(
        'OUTPUT_TRUNCATED',
        422,
        '模型没有返回任何内容，输出可能已被截断。',
        { retryable: true, detail: { finishReason } },
      );
    }
  }

  private parseAndValidateOutput(
    content: string,
    settings: ProviderConnectionSettings,
  ): EvaluateResult {
    const parsed = parseWirePlanContent(content);

    if (!parsed.ok) {
      return { ok: false, kind: 'parse', issues: parsed.issues };
    }

    const generatedAt = this.now().toISOString();
    const { plan, issues: normalizeIssues } = normalizeWirePlan(parsed.wire, {
      createId: this.createId,
      generatedAt,
      source: 'paste',
      model: settings.model,
      version: '1',
    });

    const issues = [...normalizeIssues, ...validatePlan(plan, { requireGeneratedShape: true })];

    if (issues.length > 0) {
      return { ok: false, kind: 'integrity', issues };
    }

    return { ok: true, plan, raw: parsed.raw };
  }
}

function leafFieldsFromWire(wire: WireNode): RegeneratedLeafFields {
  const deps = Array.from(
    new Set(
      wire.deps
        .map((dependencyId) => dependencyId.trim())
        .filter((dependencyId) => dependencyId.length > 0),
    ),
  );

  return {
    title: wire.title,
    desc: wire.desc.trim() || undefined,
    priority: wire.priority === '' ? undefined : wire.priority,
    estimateHours: wire.estimateHours,
    deps,
    acceptance: wire.acceptance,
  };
}

function autoRetryDelay(error: unknown): number | null {
  if (!(error instanceof AppError)) return null;
  return AUTO_RETRY_DELAY_MS[error.code] ?? null;
}

function mergeUsage(
  first: ChatUsage | null,
  second: ChatUsage | null,
): ChatUsage | null {
  if (!first) return second;
  if (!second) return first;

  return {
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
  };
}
