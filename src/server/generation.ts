import { randomUUID } from 'node:crypto';

import {
  buildRepairPrompt,
  buildUserPrompt,
  TASK_PLAN_SYSTEM_PROMPT,
} from '../shared/generation';
import { countCodePoints, MAX_SOURCE_CODE_POINTS } from '../shared/source';
import {
  normalizeWirePlan,
  validatePlan,
  type Plan,
  type PlanIssue,
  type PlanRecord,
} from '../shared/plan';
import { parseWirePlanContent } from '../shared/wire';
import { AppError } from './errors';
import {
  callChatCompletion,
  GENERATION_TIMEOUT_MS,
  type CallModel,
  type ChatMessage,
  type ChatUsage,
} from './llm';
import type { PlanStore } from './plan-store';
import type { ProviderConnectionSettings } from './provider';
import type { ResolvedSettings, SettingsStore } from './settings-store';

type EvaluateResult =
  | { ok: true; plan: Plan; raw: unknown }
  | { ok: false; kind: 'parse' | 'integrity'; issues: PlanIssue[] };

export interface GenerationDependencies {
  settingsStore: Pick<SettingsStore, 'getResolved'>;
  planStore: Pick<PlanStore, 'create'>;
  callModel?: CallModel;
  now?: () => Date;
  createId?: () => string;
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
  private readonly planStore: Pick<PlanStore, 'create'>;
  private readonly callModel: CallModel;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private busy = false;

  constructor(dependencies: GenerationDependencies) {
    this.settingsStore = dependencies.settingsStore;
    this.planStore = dependencies.planStore;
    this.callModel = dependencies.callModel ?? callChatCompletion;
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? (() => randomUUID());
  }

  async generate(rawSource: unknown): Promise<PlanRecord> {
    const source = this.validateSource(rawSource);

    if (this.busy) {
      throw new AppError('BUSY', 409, '已有生成请求正在进行，请稍后再试。', {
        retryable: true,
      });
    }

    this.busy = true;

    try {
      return await this.run(source);
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

  private async run(source: string): Promise<PlanRecord> {
    const resolved = await this.settingsStore.getResolved();

    if (!resolved.apiKey) {
      throw invalidInput('尚未配置 API Key，请先在设置中填写并保存。');
    }

    const settings = toProviderSettings(resolved);
    const messages: ChatMessage[] = [
      { role: 'system', content: TASK_PLAN_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(source) },
    ];

    let response = await this.callModel(settings, {
      messages,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });
    this.assertUsable(response.content, response.finishReason);

    let usage = response.usage;
    let outcome = this.parseAndValidateOutput(response.content, settings);

    if (!outcome.ok) {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: buildRepairPrompt(outcome.issues) });

      response = await this.callModel(settings, {
        messages,
        timeoutMs: GENERATION_TIMEOUT_MS,
      });
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
        'OUTPUT_INVALID',
        422,
        '模型返回了空白内容，请重试或更换模型。',
        { detail: { finishReason } },
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
