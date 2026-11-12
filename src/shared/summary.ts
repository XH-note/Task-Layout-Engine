import { collectLeaves, type Plan, type PlanNode } from './plan';

export interface StageSummary {
  taskCount: number;
  totalHours: number;
}

export interface WeekRange {
  start: number;
  end: number;
}

export interface PlanSummary {
  stageCount: number;
  leafCount: number;
  totalHours: number;
  weekRange: WeekRange | null;
}

function validWeek(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function countTasks(nodes: PlanNode[]): number {
  return nodes.reduce(
    (total, node) => total + 1 + countTasks(node.children ?? []),
    0,
  );
}

function sumHours(nodes: PlanNode[]): number {
  return nodes.reduce(
    (total, node) => total + finiteOrZero(node.estimateHours),
    0,
  );
}

export function computeStageSummary(stage: PlanNode): StageSummary {
  const children = stage.children ?? [];
  const leaves = collectLeaves(children);

  return {
    taskCount: countTasks(children),
    totalHours: sumHours(leaves),
  };
}

export function computePlanSummary(
  plan: Pick<Plan, 'nodes' | 'milestones'>,
): PlanSummary {
  const leaves = collectLeaves(plan.nodes);

  return {
    stageCount: plan.nodes.length,
    leafCount: leaves.length,
    totalHours: sumHours(leaves),
    weekRange: computePlanWeekRange(plan.nodes, plan.milestones),
  };
}

/**
 * Summarizes every week already present in the plan. It never assigns weeks to
 * tasks, so it does not schedule work that the data does not describe.
 */
export function computePlanWeekRange(
  nodes: PlanNode[],
  milestones: Plan['milestones'],
): WeekRange | null {
  const weeks: number[] = [];

  const walk = (list: PlanNode[]) => {
    for (const node of list) {
      if (validWeek(node.startWeek)) weeks.push(node.startWeek);
      if (validWeek(node.endWeek)) weeks.push(node.endWeek);
      if (node.children) walk(node.children);
    }
  };

  walk(nodes);

  for (const milestone of milestones) {
    if (validWeek(milestone.week)) weeks.push(milestone.week);
  }

  if (weeks.length === 0) return null;

  return {
    start: Math.min(...weeks),
    end: Math.max(...weeks),
  };
}

export function formatWeekRange(range: WeekRange | null): string {
  if (!range) return '未指定';
  if (range.start === range.end) return `W${range.start}`;
  return `W${range.start}–W${range.end}`;
}

export function formatWeek(week: number | undefined): string {
  return validWeek(week) ? `W${week}` : '未指定';
}

export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return '—';

  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} 小时`;
}

export function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未记录';

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const SOURCE_LABELS: Record<string, string> = {
  paste: '粘贴原文',
};

/** 把内部的来源标记换成文档里可读的说明。 */
export function formatPlanSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '未记录';

  return SOURCE_LABELS[trimmed] ?? trimmed;
}
