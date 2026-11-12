import { describe, expect, it } from 'vitest';

import { budgetAgentMessages } from '../src/renderer/agent/runtime/context';
import type { Message } from '../src/shared/types';

function message(index: number, content: string, role: Message['role'] = 'user'): Message {
  return { id: String(index), role, content, timestamp: index };
}

describe('budgetAgentMessages', () => {
  it('未超预算时保持原消息（system 与最近消息不动）', () => {
    const messages = [
      message(1, 'system', 'system'),
      message(2, 'hello'),
      message(3, 'world', 'assistant'),
      message(4, 'tail'),
    ];
    const result = budgetAgentMessages(messages, { maxChars: 1000, keepRecent: 2 });
    expect(result.map((item) => item.content)).toEqual(['system', 'hello', 'world', 'tail']);
  });

  it('超预算时折叠较早消息并保留最近若干条原文', () => {
    const huge = 'x'.repeat(500);
    const messages = [
      message(1, 'system', 'system'),
      message(2, huge),
      message(3, huge),
      message(4, 'recent-1'),
      message(5, 'recent-2'),
    ];
    const result = budgetAgentMessages(messages, { maxChars: 300, keepRecent: 2 });
    const contents = result.map((item) => item.content);
    expect(contents).toContain('recent-1');
    expect(contents).toContain('recent-2');
    expect(contents.some((content) => content.includes('已折叠'))).toBe(true);
    // 两条巨大的旧消息不应再以原文出现
    expect(contents.filter((content) => content === huge)).toHaveLength(0);
  });

  it('单条消息超单条上限时被裁剪', () => {
    const messages = [message(1, 'a'.repeat(100)), message(2, 'tail')];
    const result = budgetAgentMessages(messages, { maxChars: 10000, keepRecent: 1, singleMessageMaxChars: 10 });
    expect(result[0].content.length).toBeLessThanOrEqual(40);
    expect(result[0].content).toContain('内容过长已折叠');
  });
});
