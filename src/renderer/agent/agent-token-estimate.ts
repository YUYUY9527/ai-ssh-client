import type { Message } from '../../shared/types';

/**
 * Rough token estimate for a message list (about 4 characters per token).
 *
 * Kept in its own dependency-free module on purpose. It previously lived in the
 * agent flow module, which statically imported the LangGraph runtime; importing
 * this pure helper from there pulled ~800 KB of dependencies into the eagerly
 * evaluated `AgentExecutor` chunk and defeated the `await import()` code
 * splitting in AgentRuntime. Keep this file free of heavy imports.
 */
export function estimateAgentMessagesTokens(messages: Message[]): number {
  return messages.reduce(
    (total, message) => total + Math.ceil(message.content.length / 4) + 4,
    0,
  );
}
