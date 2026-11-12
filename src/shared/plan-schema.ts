import { z } from 'zod';

import type { Plan, PlanNode, PlanRecord } from './plan';

const prioritySchema = z.enum(['P0', 'P1', 'P2']);

export const planNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    title: z.string(),
    desc: z.string().optional(),
    children: z.array(planNodeSchema).optional(),
    priority: prioritySchema.optional(),
    estimateHours: z.number().optional(),
    deps: z.array(z.string()).optional(),
    acceptance: z.string().optional(),
    startWeek: z.number().optional(),
    endWeek: z.number().optional(),
  }),
);

export const planSchema: z.ZodType<Plan> = z.object({
  title: z.string(),
  goal: z.string(),
  background: z.string(),
  risks: z.array(z.string()),
  milestones: z.array(
    z.object({
      name: z.string(),
      week: z.number().optional(),
    }),
  ),
  acceptance: z.array(z.string()),
  nodes: z.array(planNodeSchema),
  meta: z.object({
    generatedAt: z.string(),
    source: z.string(),
    model: z.string(),
    version: z.string(),
  }),
});

export const planRecordSchema: z.ZodType<PlanRecord> = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string(),
  plan: planSchema,
  source: z.string(),
  model: z.string(),
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
    })
    .nullable(),
  raw: z.unknown().optional(),
});
