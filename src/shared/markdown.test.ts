import { describe, expect, it } from 'vitest';

import {
  escapeMarkdownTableCell,
  planMarkdownFileName,
  renderPlanLeafRows,
  renderPlanMarkdown,
} from './markdown';
import { normalizeWirePlan, type PlanRecord } from './plan';
import { validWirePlan } from '../test-support/wire-plan';

function sampleRecord(): PlanRecord {
  let counter = 0;
  const { plan } = normalizeWirePlan(validWirePlan(), {
    createId: () => `id-${++counter}`,
  });

  return {
    id: 'record-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: plan.title,
    plan,
    source: '原始材料',
    model: 'deepseek-chat',
    usage: null,
  };
}

describe('renderPlanMarkdown', () => {
  it('renders the plan title, metadata, sections and task numbering', () => {
    const markdown = renderPlanMarkdown(sampleRecord());

    expect(markdown).toContain('# 系统迁移计划');
    expect(markdown).toContain('## 元信息');
    expect(markdown).toContain('- 来源：粘贴原文');
    expect(markdown).toContain('- 阶段数：3');
    expect(markdown).toContain('- 叶子任务：12');
    expect(markdown).toContain('## 目标');
    expect(markdown).toContain('## 背景');
    expect(markdown).toContain('## 任务分解');
    expect(markdown).toContain('### 1 准备阶段');
    expect(markdown).toContain('#### 1.1 盘点依赖');
    expect(markdown).toContain('#### 2.2 切换 DNS');
    expect(markdown).toContain('依赖：1.4');
    expect(markdown).toContain('## 里程碑');
    expect(markdown).toContain('| M1 | 完成演练 | W2 |');
    expect(markdown).toContain('## 风险与假设');
    expect(markdown).toContain('## 计划级验收');
  });

  it('escapes pipes in milestone table cells', () => {
    const record = sampleRecord();
    record.plan.milestones[0].name = '完成|演练';

    const markdown = renderPlanMarkdown(record);

    expect(markdown).toContain('| M1 | 完成\\|演练 | W2 |');
    expect(markdown).not.toContain('| M1 | 完成|演练 |');
  });

  it('uses placeholders for empty optional sections', () => {
    const record = sampleRecord();
    record.plan.risks = [];
    record.plan.acceptance = [];
    record.plan.milestones = [];

    const markdown = renderPlanMarkdown(record);

    expect(markdown).toContain('## 风险与假设\n\n（无）');
    expect(markdown).toContain('## 计划级验收\n\n（无）');
    expect(markdown).toContain('## 里程碑\n\n（无）');
  });

  it('keeps task ids out of the Markdown', () => {
    const markdown = renderPlanMarkdown(sampleRecord());

    expect(markdown).not.toContain('id-2');
  });
});

describe('renderPlanLeafRows', () => {
  it('lists leaves grouped by their stage with numbers and dependencies', () => {
    const record = sampleRecord();
    const rows = renderPlanLeafRows(record.plan);

    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({
      stageId: 'id-1',
      stageTitle: '准备阶段',
      number: '1.1',
    });
    expect(rows.find((row) => row.node.title === '切换 DNS')).toMatchObject({
      stageId: 'id-6',
      stageTitle: '执行阶段',
      number: '2.2',
      dependencies: '1.4',
    });
  });
});

describe('planMarkdownFileName', () => {
  it('replaces characters that are invalid in file names', () => {
    expect(planMarkdownFileName('迁移/计划: 2026?')).toBe(
      '任务计划书-迁移-计划- 2026.md',
    );
  });

  it('falls back to a usable name', () => {
    expect(planMarkdownFileName('   ')).toBe('任务计划书-未命名.md');
  });
});

describe('escapeMarkdownTableCell', () => {
  it('escapes backslashes, pipes and newlines', () => {
    expect(escapeMarkdownTableCell('a\\b|c\nd')).toBe('a\\\\b\\|c d');
  });
});
