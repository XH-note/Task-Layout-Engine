import { describe, expect, it } from 'vitest';

import {
  extractJsonCandidate,
  parseWirePlanContent,
} from './wire';
import { cloneWirePlan, findWireNode, validWireJson, validWirePlan } from '../test-support/wire-plan';

describe('extractJsonCandidate', () => {
  it('strips BOM, prose and fenced code blocks', () => {
    const content = `\uFEFF这是说明文字。\n\`\`\`json\n${validWireJson()}\n\`\`\`\n后面的文字。`;

    expect(extractJsonCandidate(content)).toBe(validWireJson());
  });

  it('returns null when no JSON object is present', () => {
    expect(extractJsonCandidate('模型拒绝回答。')).toBeNull();
    expect(extractJsonCandidate('   ')).toBeNull();
  });
});

describe('parseWirePlanContent', () => {
  it('parses a valid wire plan and reports whether repair was needed', () => {
    const result = parseWirePlanContent(validWireJson());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(false);
    expect(result.wire.nodes).toHaveLength(3);
    expect(result.wire.title).toBe('系统迁移计划');
  });

  it('repairs locally recoverable JSON with jsonrepair', () => {
    const broken = `${validWireJson().slice(0, -1)},}`;
    const result = parseWirePlanContent(broken);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(true);
    expect(result.wire.nodes).toHaveLength(3);
  });

  it('reports zod field paths when the wire shape is wrong', () => {
    const wire = cloneWirePlan();
    const leaf = findWireNode(wire, 'n2');
    expect(leaf).toBeDefined();
    delete (leaf as { acceptance?: string }).acceptance;

    const result = parseWirePlanContent(JSON.stringify(wire));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'nodes[0].children[0].acceptance' }),
      ]),
    );
  });

  it('fails clearly when the content has no JSON object', () => {
    const result = parseWirePlanContent('抱歉，我无法完成这个请求。');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('没有可解析的 JSON');
  });

  it('accepts the default wire plan produced by the fixture', () => {
    const result = parseWirePlanContent(JSON.stringify(validWirePlan()));

    expect(result.ok).toBe(true);
  });
});
