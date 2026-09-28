import { describe, it, expect } from 'vitest';

import { parseAgentResponse } from '../src/renderer/agent/agent-runtime';

/**
 * 响应解析的安全约束。
 *
 * 1. **JSON 修复不得改变取值**：旧 `fixMalformedJson` 里有 `replace(/'/g, '"')` 与
 *    尾逗号正则 `/,\s*([}\]])/g`，前者会把命令里的撇号换成双引号
 *    （`echo "it's"` → `echo "it"s"`），后者会篡改字符串值（`"a,}"` → `"a}"`）——
 *    而被污染的字符串就是最终执行的命令。
 * 2. **禁止从散文推断 execute**：旧实现会从「执行命令：xxx」里抓命令并执行，
 *    低风险命令完全绕过审批。
 */

describe('parseAgentResponse — JSON 修复保持语义', () => {
  it('保留命令中的撇号（尾逗号修复路径）', () => {
    const raw = '{"thought":{"reasoning":"x"},"decision":"execute","command":"echo \\"it\'s\\"",}';
    expect(parseAgentResponse(raw)).toMatchObject({
      decision: 'execute',
      command: 'echo "it\'s"',
    });
  });

  it('保留字符串值里的括号与逗号（尾逗号修复路径）', () => {
    const raw = '{"thought":{"reasoning":"a,}"},"decision":"finish","finishReason":"a,}",}';
    expect(parseAgentResponse(raw)).toMatchObject({
      decision: 'finish',
      finishReason: 'a,}',
    });
  });

  it('字符串值内的裸换行会被转义而不是丢弃', () => {
    const raw = '{"thought":{"reasoning":"line1\nline2"},"decision":"finish","finishReason":"ok"}';
    expect(parseAgentResponse(raw)?.thought.reasoning).toBe('line1\nline2');
  });

  it('单引号 JSON 仍可解析', () => {
    expect(parseAgentResponse("{'thought':{'reasoning':'x'},'decision':'finish','finishReason':'ok'}"))
      .toMatchObject({ decision: 'finish', finishReason: 'ok' });
  });

  it('markdown 代码块里的 JSON 照常解析', () => {
    expect(parseAgentResponse('```json\n{"thought":{"reasoning":"x"},"decision":"execute","command":"ls -la"}\n```'))
      .toMatchObject({ decision: 'execute', command: 'ls -la' });
  });
});

describe('parseAgentResponse — 散文不再触发执行', () => {
  it.each([
    '我将执行命令：rm -rf /tmp/demo',
    '执行: systemctl restart nginx',
    '使用 `docker ps` 查看容器状态',
    'run: poweroff',
    '```\npoweroff\n```',
  ])('%s → 不得为 execute', (text) => {
    const parsed = parseAgentResponse(text);
    expect(parsed?.decision).not.toBe('execute');
    expect(parsed?.command).toBeUndefined();
  });

  it('纯文本澄清请求仍然按 ask 处理', () => {
    expect(parseAgentResponse('请告诉我具体要检查哪个服务？')).toMatchObject({ decision: 'ask' });
  });

  it('结构化 JSON 仍然是执行命令的唯一入口', () => {
    expect(parseAgentResponse('{"thought":{"reasoning":"x"},"decision":"execute","command":"ls"}'))
      .toMatchObject({ decision: 'execute', command: 'ls' });
  });
});
