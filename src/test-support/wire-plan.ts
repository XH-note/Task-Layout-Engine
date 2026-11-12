import type { WireNode, WirePlan } from '../shared/wire';

function leaf(key: string, title: string, deps: string[] = []): WireNode {
  return {
    key,
    title,
    desc: `${title}的一句话说明`,
    priority: 'P1',
    estimateHours: 2,
    deps,
    acceptance: `${title}的验收标准`,
    children: [],
  };
}

function stage(key: string, title: string, children: WireNode[]): WireNode {
  return {
    key,
    title,
    desc: '',
    priority: '',
    estimateHours: 0,
    deps: [],
    acceptance: '',
    children,
  };
}

export function validWirePlan(): WirePlan {
  return {
    title: '系统迁移计划',
    goal: '在不中断业务的前提下完成系统迁移。',
    background: '旧系统已运行五年，维护成本持续上升。',
    risks: ['切换窗口内流量异常'],
    milestones: [
      { name: '完成演练', week: 'W2' },
      { name: '正式上线', week: 'W5' },
    ],
    acceptance: ['新系统承接全部流量一周且无 P0 事故'],
    nodes: [
      stage('n1', '准备阶段', [
        leaf('n2', '盘点依赖'),
        leaf('n3', '备份数据'),
        leaf('n4', '编写脚本'),
        leaf('n5', '回滚演练'),
      ]),
      stage('n6', '执行阶段', [
        leaf('n7', '冻结发布'),
        leaf('n8', '切换 DNS', ['n5']),
        leaf('n9', '验证流量'),
        leaf('n10', '准备回滚'),
      ]),
      stage('n11', '收尾阶段', [
        leaf('n12', '观察一周'),
        leaf('n13', '清理旧机'),
        leaf('n14', '更新文档'),
        leaf('n15', '复盘总结'),
      ]),
    ],
  };
}

export function validWireJson(): string {
  return JSON.stringify(validWirePlan());
}

export function findWireNode(plan: WirePlan, key: string): WireNode | undefined {
  const walk = (nodes: WireNode[]): WireNode | undefined => {
    for (const node of nodes) {
      if (node.key === key) return node;
      const found = walk(node.children);
      if (found) return found;
    }

    return undefined;
  };

  return walk(plan.nodes);
}

export function cloneWirePlan(plan: WirePlan = validWirePlan()): WirePlan {
  return structuredClone(plan);
}
