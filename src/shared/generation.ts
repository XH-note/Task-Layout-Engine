import type { LeafOption, PlanNode, PlanIssue } from './plan';
import {
  WIRE_LEAF_JSON_SCHEMA,
  WIRE_PLAN_JSON_SCHEMA,
  type WireNode,
  type WirePlan,
} from './wire';

const WIRE_EXAMPLE: WirePlan = {
  title: '示例计划',
  goal: '一句话说明要达成的目标。',
  background: '一句话说明项目背景。',
  risks: ['一个主要风险'],
  milestones: [{ name: '完成准备', week: 'W2' }],
  acceptance: ['整体验收标准'],
  nodes: [
    {
      key: 'k1',
      title: '准备阶段',
      desc: '',
      priority: '',
      estimateHours: 0,
      deps: [],
      acceptance: '',
      children: [
        {
          key: 'k2',
          title: '任务一',
          desc: '任务说明',
          priority: 'P1',
          estimateHours: 2,
          deps: [],
          acceptance: '可检查的验收标准',
          children: [],
        },
        {
          key: 'k3',
          title: '任务二',
          desc: '任务说明',
          priority: 'P0',
          estimateHours: 1,
          deps: [],
          acceptance: '可检查的验收标准',
          children: [],
        },
        {
          key: 'k4',
          title: '任务三',
          desc: '任务说明',
          priority: 'P2',
          estimateHours: 4,
          deps: ['k2'],
          acceptance: '可检查的验收标准',
          children: [],
        },
      ],
    },
    {
      key: 'k5',
      title: '执行阶段',
      desc: '',
      priority: '',
      estimateHours: 0,
      deps: [],
      acceptance: '',
      children: [
        {
          key: 'k6',
          title: '任务四',
          desc: '任务说明',
          priority: 'P1',
          estimateHours: 2,
          deps: ['k3'],
          acceptance: '可检查的验收标准',
          children: [],
        },
        {
          key: 'k7',
          title: '任务五',
          desc: '任务说明',
          priority: 'P1',
          estimateHours: 2,
          deps: [],
          acceptance: '可检查的验收标准',
          children: [],
        },
        {
          key: 'k8',
          title: '任务六',
          desc: '任务说明',
          priority: 'P2',
          estimateHours: 3,
          deps: ['k4'],
          acceptance: '可检查的验收标准',
          children: [],
        },
      ],
    },
  ],
};

export const TASK_PLAN_SYSTEM_PROMPT = [
  '你是一名资深项目负责人，负责把用户粘贴的项目材料整理成可执行的任务计划书。',
  '只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或前后缀文字。',
  '',
  '必须遵守以下规则：',
  '- 使用中文输出；计划要有 2–4 个阶段（顶层节点），每个阶段至少 3 个任务节点，叶子任务总数必须在 12–20 个之间。',
  '- 顶层节点是阶段，只作为分组：priority 填空字符串、estimateHours 填 0、deps 填空数组、acceptance 填空字符串。',
  '- 有 children 的节点是分组，也不能设置 priority、estimateHours、deps、acceptance；叶子任务必须有 children: []。',
  '- 层级最多 3 层：阶段 → 任务 → 子任务。不要创建更深的层级。',
  '- 每个叶子任务必须填写 priority（P0/P1/P2）、0.5–8 之间的 estimateHours、非空 acceptance。',
  '- 叶子任务的 title 不超过 24 个字符，desc 不超过 60 个字符，acceptance 不超过 40 个字符。',
  '- deps 只能引用其它叶子任务的 key，不能引用阶段或分组；不要依赖自身，不能出现循环依赖，跨阶段依赖是可以的。',
  '- key 在整份计划内唯一，使用 k1、k2 这样的临时值；最终节点 id 由程序生成。',
  '- milestones.week 只能使用 W1–W6；不要生成具体日期。',
  '- 计划要贴合用户材料，不要编造材料中不存在的重大前提。',
  '',
  '返回的 JSON 必须完全符合下面的 JSON Schema：',
  JSON.stringify(WIRE_PLAN_JSON_SCHEMA, null, 2),
  '',
  '结构示例（仅演示字段形状，实际必须生成 12–20 个叶子任务）：',
  JSON.stringify(WIRE_EXAMPLE, null, 2),
].join('\n');

const WIRE_LEAF_EXAMPLE: WireNode = {
  key: 'leaf',
  title: '重写后的任务标题',
  desc: '一句话说明这条任务要做什么。',
  priority: 'P1',
  estimateHours: 2,
  deps: [],
  acceptance: '可检查的验收标准',
  children: [],
};

/**
 * The full-plan prompt requires 12–20 leaves and a whole plan, so it cannot be
 * reused for a single-node regeneration. This prompt keeps the same output
 * discipline (JSON only, same leaf rules) but asks for exactly one leaf.
 */
export const LEAF_REGENERATION_SYSTEM_PROMPT = [
  '你是一名资深项目负责人，负责只重写任务计划书中的一个叶子任务。',
  '只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或前后缀文字。',
  '',
  '必须遵守以下规则：',
  '- 使用中文输出；只重写给定的这一个叶子任务，不要新增阶段、分组或子节点。',
  '- children 必须是空数组。',
  '- priority 必须是 P0/P1/P2，estimateHours 必须在 0.5–8 之间，acceptance 必须非空。',
  '- title 不超过 24 个字符，desc 不超过 60 个字符，acceptance 不超过 40 个字符。',
  '- deps 只能使用用户消息中列出的“可依赖叶子任务 id”，不能包含当前任务自身的 id，不能出现循环依赖。',
  '- 如果不打算调整依赖，请原样返回当前依赖；不要因为不确定就清空 deps。',
  '- key 随意填写一个非空字符串即可，最终节点 id 由程序保留原值。',
  '- 新标题和新说明要贴合原任务与计划目标，不要编造材料中不存在的重大前提。',
  '',
  '返回的 JSON 必须完全符合下面的 JSON Schema：',
  JSON.stringify(WIRE_LEAF_JSON_SCHEMA, null, 2),
  '',
  '结构示例：',
  JSON.stringify(WIRE_LEAF_EXAMPLE, null, 2),
].join('\n');

export interface LeafRegenerationPromptInput {
  planTitle: string;
  goal: string;
  stagePath: string[];
  node: PlanNode;
  siblings: string[];
  dependencies: string[];
  leafOptions: LeafOption[];
}

function describeLeafDependencies(node: PlanNode): string {
  const deps = node.deps ?? [];
  return deps.length > 0 ? deps.join(', ') : '（无）';
}

export function buildLeafRegenerationPrompt(
  input: LeafRegenerationPromptInput,
): string {
  const { node } = input;

  return [
    '请重写下面这个叶子任务，使其更清晰、可执行；只输出单个 JSON 对象。',
    '',
    `计划标题：${input.planTitle}`,
    `计划目标：${input.goal}`,
    `阶段路径：${input.stagePath.join(' / ')}`,
    `当前任务 id：${node.id}`,
    '',
    '当前内容：',
    `- 标题：${node.title}`,
    `- 说明：${node.desc ?? ''}`,
    `- 优先级：${node.priority ?? ''}`,
    `- 工时：${node.estimateHours ?? ''}`,
    `- 验收标准：${node.acceptance ?? ''}`,
    `- 依赖 id：${describeLeafDependencies(node)}`,
    '',
    '同级任务标题：',
    ...(input.siblings.length > 0
      ? input.siblings.map((title) => `- ${title}`)
      : ['- （无）']),
    '',
    '当前依赖的任务标题：',
    ...(input.dependencies.length > 0
      ? input.dependencies.map((title) => `- ${title}`)
      : ['- （无）']),
    '',
    '可依赖的叶子任务（deps 只能使用这些 id，且不能包含当前任务 id）：',
    ...(input.leafOptions.length > 0
      ? input.leafOptions.map(
          (option) => `- ${option.id} | ${option.number} ${option.path}`,
        )
      : ['- （无）']),
    '',
    '只输出一个 JSON 对象，不要输出其它内容。',
  ].join('\n');
}

export function buildUserPrompt(source: string): string {
  return ['以下是需要整理的项目材料：', '', source, '', '只输出 JSON。'].join('\n');
}

export function buildRepairPrompt(issues: PlanIssue[]): string {
  const lines = issues.slice(0, 20).map((issue) => `- ${issue.path}: ${issue.message}`);

  return [
    '上一次输出没有通过校验，问题如下：',
    ...lines,
    '',
    '请修正这些问题，并只输出修正后的完整 JSON 对象。',
  ].join('\n');
}
