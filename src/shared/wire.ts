import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

import type { PlanIssue } from './plan';

export type WirePriority = '' | 'P0' | 'P1' | 'P2';

export interface WireNode {
  key: string;
  title: string;
  desc: string;
  priority: WirePriority;
  estimateHours: number;
  deps: string[];
  acceptance: string;
  children: WireNode[];
}

export interface WirePlan {
  title: string;
  goal: string;
  background: string;
  risks: string[];
  milestones: { name: string; week: string }[];
  acceptance: string[];
  nodes: WireNode[];
}

const wirePrioritySchema = z.enum(['', 'P0', 'P1', 'P2']);
const wireWeekSchema = z
  .string()
  .regex(/^(?:W[1-9]\d*)?$/, '周次必须是 "W3" 这样的格式，或空字符串');

const wireNodeSchema: z.ZodType<WireNode> = z.lazy(() =>
  z.object({
    key: z.string().min(1, 'key 不能为空'),
    title: z.string(),
    desc: z.string(),
    priority: wirePrioritySchema,
    estimateHours: z.number().refine(Number.isFinite, 'estimateHours 必须是有限数字'),
    deps: z.array(z.string()),
    acceptance: z.string(),
    children: z.array(wireNodeSchema),
  }),
);

const wirePlanSchema: z.ZodType<WirePlan> = z.object({
  title: z.string(),
  goal: z.string(),
  background: z.string(),
  risks: z.array(z.string()),
  milestones: z.array(
    z.object({
      name: z.string(),
      week: wireWeekSchema,
    }),
  ),
  acceptance: z.array(z.string()),
  nodes: z.array(wireNodeSchema),
});

export const WIRE_NODE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    title: { type: 'string' },
    desc: { type: 'string' },
    priority: { type: 'string', enum: ['', 'P0', 'P1', 'P2'] },
    estimateHours: { type: 'number', minimum: 0, maximum: 8 },
    deps: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'string' },
    children: { type: 'array', items: { $ref: '#/$defs/node' } },
  },
  required: [
    'key',
    'title',
    'desc',
    'priority',
    'estimateHours',
    'deps',
    'acceptance',
    'children',
  ],
  additionalProperties: false,
} as const;

export const WIRE_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    goal: { type: 'string' },
    background: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          week: { type: 'string', pattern: '^(?:W[1-9]\\d*)?$' },
        },
        required: ['name', 'week'],
        additionalProperties: false,
      },
    },
    acceptance: { type: 'array', items: { type: 'string' } },
    nodes: { type: 'array', items: { $ref: '#/$defs/node' } },
  },
  required: ['title', 'goal', 'background', 'risks', 'milestones', 'acceptance', 'nodes'],
  additionalProperties: false,
  $defs: {
    node: WIRE_NODE_JSON_SCHEMA,
  },
} as const;

export type WireParseResult =
  | { ok: true; wire: WirePlan; raw: unknown; repaired: boolean }
  | { ok: false; issues: PlanIssue[] };

function formatZodPath(path: readonly PropertyKey[]): string {
  let formatted = '';

  for (const part of path) {
    if (typeof part === 'number') {
      formatted += `[${part}]`;
    } else {
      formatted += formatted ? `.${String(part)}` : String(part);
    }
  }

  return formatted || '$';
}

export function extractJsonCandidate(content: string): string | null {
  const withoutBom = content.replace(/^\uFEFF/, '').trim();
  if (!withoutBom) return null;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(withoutBom);
  const body = fence?.[1] ?? withoutBom;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) return null;

  return body.slice(start, end + 1);
}

export function parseWirePlanContent(content: string): WireParseResult {
  const candidate = extractJsonCandidate(content);

  if (!candidate) {
    return {
      ok: false,
      issues: [{ path: '$', message: '模型返回的内容里没有可解析的 JSON 对象。' }],
    };
  }

  let raw: unknown;
  let repaired = false;

  try {
    raw = JSON.parse(candidate);
  } catch {
    repaired = true;

    try {
      raw = JSON.parse(jsonrepair(candidate));
    } catch {
      return {
        ok: false,
        issues: [
          { path: '$', message: '模型返回的 JSON 无法解析，本地修复也失败。' },
        ],
      };
    }
  }

  const parsed = wirePlanSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: formatZodPath(issue.path),
        message: issue.message,
      })),
    };
  }

  return { ok: true, wire: parsed.data, raw, repaired };
}
