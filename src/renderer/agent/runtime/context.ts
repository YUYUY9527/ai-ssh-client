import type { Message } from '../../../shared/types';

/**
 * Agent 上下文预算裁剪（批次二）。
 *
 * 目的：命令行输出会随轮次线性堆积，一次 `cat` 大文件就可能吃掉整个上下文。
 * 这里按「字符预算」从旧到新折叠历史，保留最近若干条原文，并把被折叠的内容
 * 替换为带省略标记的摘要，避免模型误以为输出被截断丢失。
 *
 * 与旧实现的区别：旧逻辑只在 token 估算超阈值时整段摘要（AGENT_SUMMARY_*）；
 * 该函数作为轻量兜底，独立于摘要，逐条折叠，成本更低。
 */

export interface AgentContextBudgetOptions {
  /** 历史正文总字符预算，默认 120000（约 30k~40k token）。 */
  maxChars?: number;
  /** 尾部始终保留原文的消息条数，默认 4。 */
  keepRecent?: number;
  /** 单条消息正文最大字符数，默认 24000。 */
  singleMessageMaxChars?: number;
}

export const AGENT_CONTEXT_DEFAULT_MAX_CHARS = 120_000;
export const AGENT_CONTEXT_DEFAULT_KEEP_RECENT = 4;
export const AGENT_CONTEXT_SINGLE_MAX_CHARS = 24_000;

const ELLIPSIS = '\n\n...[内容过长已折叠]...';

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + ELLIPSIS;
}

/**
 * 按预算折叠历史消息。纯函数，不修改入参。
 * 规则：
 * 1. 先对每条消息做单条上限裁剪（system 除外，system 通常很短且必须完整）。
 * 2. 从尾部向前累计字符数，超过预算的更早消息整体折叠为一条占位摘要。
 * 3. 最近 keepRecent 条永不折叠。
 */
export function budgetAgentMessages(
  messages: Message[],
  options: AgentContextBudgetOptions = {},
): Message[] {
  const maxChars = options.maxChars ?? AGENT_CONTEXT_DEFAULT_MAX_CHARS;
  const keepRecent = options.keepRecent ?? AGENT_CONTEXT_DEFAULT_KEEP_RECENT;
  const singleMax = options.singleMessageMaxChars ?? AGENT_CONTEXT_SINGLE_MAX_CHARS;

  const clipped = messages.map((message, index) => {
    if (message.role === 'system') return message;
    const content = typeof message.content === 'string' ? message.content : '';
    const limit = index >= messages.length - keepRecent ? singleMax * 2 : singleMax;
    return content.length > limit ? { ...message, content: clip(content, limit) } : message;
  });

  let total = 0;
  const keepFrom = Math.max(0, clipped.length - keepRecent);
  const result: Message[] = [];
  const folded: string[] = [];

  for (let index = clipped.length - 1; index >= 0; index -= 1) {
    const message = clipped[index];
    const length = typeof message.content === 'string' ? message.content.length : 0;
    const mustKeep = index >= keepFrom || message.role === 'system';

    if (!mustKeep && total + length > maxChars) {
      folded.unshift(`- [${message.role}] ${clip(String(message.content || ''), 160)}`);
      continue;
    }

    result.unshift(message);
    total += length;
  }

  if (folded.length > 0) {
    result.unshift({
      id: `agent-context-folded-${folded.length}`,
      role: 'system',
      content: `以下较早的历史消息因超出上下文预算已折叠（仅保留摘要，原始输出已省略）：\n${folded.join('\n')}`,
      timestamp: Date.now(),
    } as Message);
  }

  return result;
}
