import {
  collectLeaves,
  computeNodeNumbers,
  isGroup,
  resolveDependencyNumbers,
  type Plan,
  type PlanNode,
  type PlanRecord,
} from './plan';
import {
  computePlanSummary,
  computeStageSummary,
  formatGeneratedAt,
  formatHours,
  formatPlanSource,
  formatWeek,
  formatWeekRange,
} from './summary';

const EMPTY = '（无）';

function inline(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

function hours(value: number | undefined): string {
  return value === undefined ? '未设置' : formatHours(value);
}

export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

export function planMarkdownFileName(title: string): string {
  const safe = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60);

  return `任务计划书-${safe || '未命名'}.md`;
}

function renderNode(
  lines: string[],
  node: PlanNode,
  depth: number,
  numbers: Map<string, string>,
): void {
  const number = numbers.get(node.id) ?? '';
  const headingLevel = Math.min(2 + depth, 6);
  lines.push(`${'#'.repeat(headingLevel)} ${number} ${inline(node.title)}`.trim(), '');

  if (isGroup(node)) {
    if (node.desc) lines.push(inline(node.desc), '');
    for (const child of node.children ?? []) {
      renderNode(lines, child, depth + 1, numbers);
    }
    return;
  }

  const dependencies = resolveDependencyNumbers(node.deps, numbers).join('、') || '—';
  lines.push(
    `- 优先级：${node.priority ?? '未设置'} ｜ 工时：${hours(node.estimateHours)} ｜ 依赖：${dependencies}`,
    '',
  );

  if (node.desc) lines.push(`**说明**：${inline(node.desc)}`, '');
  if (node.acceptance) lines.push(`**验收**：${inline(node.acceptance)}`, '');
}

export function renderPlanMarkdown(record: PlanRecord): string {
  const plan: Plan = record.plan;
  const summary = computePlanSummary(plan);
  const numbers = computeNodeNumbers(plan.nodes);
  const lines: string[] = [];

  lines.push(`# ${inline(record.title)}`, '');
  lines.push('## 元信息', '');
  lines.push(`- 生成时间：${formatGeneratedAt(plan.meta.generatedAt)}`);
  lines.push(`- 来源：${formatPlanSource(plan.meta.source)}`);
  lines.push(`- 阶段数：${summary.stageCount}`);
  lines.push(`- 叶子任务：${summary.leafCount}`);
  lines.push(`- 总工时：${formatHours(summary.totalHours)}`);
  lines.push(`- 周期：${formatWeekRange(summary.weekRange)}`);
  if (record.model) lines.push(`- 模型：${record.model}`);
  if (plan.meta.version) lines.push(`- 版本：${plan.meta.version}`);
  lines.push('');

  lines.push('## 目标', '', inline(plan.goal) || EMPTY, '');
  lines.push('## 背景', '', inline(plan.background) || EMPTY, '');
  lines.push('## 任务分解', '');

  for (const stage of plan.nodes) {
    const stageSummary = computeStageSummary(stage);
    lines.push(`### ${numbers.get(stage.id) ?? ''} ${inline(stage.title)}`.trim(), '');
    lines.push(
      `> ${stageSummary.taskCount} 个任务 · 合计 ${formatHours(stageSummary.totalHours)}`,
      '',
    );
    for (const child of stage.children ?? []) {
      renderNode(lines, child, 2, numbers);
    }
  }

  lines.push('## 里程碑', '');
  if (plan.milestones.length === 0) {
    lines.push(EMPTY, '');
  } else {
    lines.push('| 编号 | 名称 | 周次 |');
    lines.push('| --- | --- | --- |');
    plan.milestones.forEach((milestone, index) => {
      lines.push(
        `| M${index + 1} | ${escapeMarkdownTableCell(milestone.name)} | ${formatWeek(milestone.week)} |`,
      );
    });
    lines.push('');
  }

  lines.push('## 风险与假设', '');
  if (plan.risks.length === 0) {
    lines.push(EMPTY, '');
  } else {
    for (const risk of plan.risks) lines.push(`- ${inline(risk)}`);
    lines.push('');
  }

  lines.push('## 计划级验收', '');
  if (plan.acceptance.length === 0) {
    lines.push(EMPTY, '');
  } else {
    for (const item of plan.acceptance) lines.push(`- ${inline(item)}`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export interface PlanLeafRow {
  stageId: string;
  stageTitle: string;
  number: string;
  node: PlanNode;
  dependencies: string;
}

export function renderPlanLeafRows(plan: Plan): PlanLeafRow[] {
  const numbers = computeNodeNumbers(plan.nodes);
  const leaves = new Set(collectLeaves(plan.nodes).map((leaf) => leaf.id));
  const rows: PlanLeafRow[] = [];

  for (const stage of plan.nodes) {
    const walk = (nodes: PlanNode[]) => {
      for (const node of nodes) {
        if (leaves.has(node.id)) {
          rows.push({
            stageId: stage.id,
            stageTitle: stage.title,
            number: numbers.get(node.id) ?? '',
            node,
            dependencies:
              resolveDependencyNumbers(node.deps, numbers).join('、') || '—',
          });
        } else {
          walk(node.children ?? []);
        }
      }
    };

    walk(stage.children ?? []);
  }

  return rows;
}
