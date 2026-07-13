import { create } from 'zustand';
import type { AIProviderConfig, AIProviderSummary, Message, CommandSuggestion } from '../../shared/types';
import type { AIChatResponse } from '../../shared/ipc-types';
import { extractCommand, riskAnalysisToSuggestion } from '../ai';
import { useSessionStore } from '../session/useSessionStore';
import { loadSessionScrollbackSnapshots } from '../session/session-scrollback';
import { useCommandHistoryStore } from '../history/useCommandHistoryStore';
import { useConnectionStore } from './useConnectionStore';
import { t } from '../i18n';

export type ContextStrategy = 'keep-all' | 'keep-recent' | 'keep-summary';

const SUMMARY_TRIGGER_THRESHOLD = 10;
const SUMMARY_MAX_LENGTH = 1200;
const SUMMARY_KEEP_RECENT = 4;
const SUMMARY_SYSTEM_PROMPT = `你是对话摘要助手。请把下面的多轮对话压缩成简洁的要点摘要，保留：关键事实、用户目标、已确认的决定、待办事项与重要的命令或结论。使用简体中文分条列出，不要寒暄，不超过 200 字。`;

function trimText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeMessages(messages: Message[]): string {
  return messages
    .slice(-6)
    .map((message) => `${message.role}: ${trimText(message.content.replace(/\s+/g, ' '), 120)}`)
    .join('\n');
}

// 构建 AI 摘要输入：已有摘要 + 待压缩的历史消息
function buildSummaryInput(messages: Message[], previousSummary: string): string {
  const history = messages
    .map((message) => `${message.role}: ${trimText(message.content.replace(/\s+/g, ' '), 400)}`)
    .join('\n');
  return previousSummary
    ? `已有摘要：\n${previousSummary}\n\n新的对话：\n${history}`
    : history;
}

function estimateMessageCost(message: Message): number {
  return message.content.length + 20;
}

function formatAIErrorMessage(message: string, code?: string): string {
  const normalized = `${code || ''} ${message}`.toLowerCase();

  if (normalized.includes('provider_not_found') || normalized.includes('not found or not active')) {
    return t('aiErrors.providerNotFound');
  }
  if (normalized.includes('缺少 api key') || normalized.includes('auth') || normalized.includes('401') || normalized.includes('403')) {
    return t('aiErrors.authFailed');
  }
  if (normalized.includes('timeout') || normalized.includes('超时')) {
    return t('aiErrors.timeout');
  }
  if (normalized.includes('429') || normalized.includes('rate')) {
    return t('aiErrors.rateLimited');
  }
  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('failed to fetch')) {
    return t('aiErrors.networkFailed');
  }
  if (normalized.includes('invalid_response') || normalized.includes('响应格式无效')) {
    return t('aiErrors.invalidResponse');
  }
  if (normalized.includes('invalid_config')) {
    return t('aiErrors.invalidConfig');
  }

  return message || t('aiErrors.defaultError');
}

const TERMINAL_CONTEXT_MAX_CHARS = 1600;

// 清理终端输出中的 ANSI 转义码
function stripAnsiSequences(text: string): string {
  return text
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// 采集当前活动会话的终端上下文（当前目录 + 最近输出），供 AI 感知会话状态
function collectTerminalContext(): string {
  try {
    const sessionState = useSessionStore.getState();
    const sessionId = sessionState.activeSessionId;
    if (!sessionId) {
      return '';
    }

    const session = sessionState.sessions[sessionId];
    const liveOutput = sessionState.outputs[sessionId] || '';
    const snapshot = loadSessionScrollbackSnapshots().find(
      (item) => item.sessionId === sessionId,
    );
    const rawOutput = liveOutput || snapshot?.content || '';
    const cleaned = stripAnsiSequences(rawOutput)
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const tail = cleaned.slice(-TERMINAL_CONTEXT_MAX_CHARS);
    const cwd = session?.cwd || snapshot?.cwd;
    const cwdLine = cwd ? `当前目录：${cwd}\n` : '';

    // 分层历史建议：优先当前 host/user/cwd 的近期命令
    const connection = useConnectionStore.getState().connections.find(
      (item) => item.id === (session?.connectionId || sessionId),
    );
    const historySuggestions = useCommandHistoryStore.getState().getSuggestions({
      host: connection?.host,
      username: connection?.username,
      cwd: cwd || undefined,
      connectionId: session?.connectionId || sessionId,
    }, 8);
    const historyLine = historySuggestions.length > 0
      ? `当前上下文近期命令（host/user/cwd 分层，仅供参考）：\n${historySuggestions.map((command) => `- ${command}`).join('\n')}\n`
      : '';

    if (!tail && !cwdLine && !historyLine) {
      return '';
    }
    return `${cwdLine}${historyLine}${tail ? `最近终端输出：\n${tail}` : ''}`.trim();
  } catch {
    return '';
  }
}

function buildChatContext(params: {
  messages: Message[];
  userMessage: Message;
  contextStrategy: ContextStrategy;
  conversationSummary: string;
  maxContextMessages: number;
  terminalContext?: string;
}): Message[] {
  const { messages, userMessage, contextStrategy, conversationSummary, maxContextMessages, terminalContext } = params;

  let systemPrompt = `你是一个专业的Linux系统管理员助手。请简洁地回答用户关于Linux命令的问题。

回复格式要求（必须严格遵守）：
1. 每行一个命令，格式：- 命令：说明
2. 命令部分在前，用冒号分隔，说明在后
3. 不要代码块，不要序号，不要多余开场白或总结`;

  if (contextStrategy === 'keep-summary' && conversationSummary) {
    systemPrompt = `【对话摘要】\n${conversationSummary}\n\n---\n\n${systemPrompt}`;
  }

  if (terminalContext) {
    systemPrompt = `${systemPrompt}\n\n【当前会话终端上下文（用于让命令建议贴合当前服务器状态，勿直接复述）】\n${terminalContext}`;
  }

  const budget = Math.max(600, maxContextMessages * 400);
  const selected: Message[] = [];
  let cost = estimateMessageCost(userMessage) + systemPrompt.length;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    const nextCost = cost + estimateMessageCost(candidate);
    if (contextStrategy !== 'keep-all' && (selected.length >= maxContextMessages || nextCost > budget)) {
      break;
    }
    selected.unshift({ ...candidate, content: trimText(candidate.content, 2000) });
    cost = nextCost;
  }

  return [
    { id: 'system', role: 'system', content: systemPrompt, timestamp: Date.now() },
    ...selected,
    userMessage,
  ];
}

interface AIState {
  providers: AIProviderSummary[];
  activeProviderId: string | null;
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  contextStrategy: ContextStrategy;
  maxContextMessages: number;
  conversationSummary: string;
  currentRequestId: string | null;
  isSummarizing: boolean;

  loadProviders: () => Promise<void>;
  saveProvider: (provider: AIProviderConfig) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  setActiveProvider: (providerId: string | null) => void;
  sendMessage: (content: string) => Promise<void>;
  cancelMessage: () => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  clearError: () => void;
  analyzeCommand: (command: string) => CommandSuggestion;
  extractCommand: (aiResponse: string) => string | null;
  setContextStrategy: (strategy: ContextStrategy) => void;
  setMaxContextMessages: (max: number) => void;
  trimContext: () => void;
  updateSummary: (summary: string) => void;
  maybeRefreshSummary: () => Promise<void>;
  getContextMessages: () => Message[];
}

export const useAIStore = create<AIState>((set, get) => ({
  providers: [],
  activeProviderId: null,
  messages: [],
  isLoading: false,
  error: null,
  contextStrategy: 'keep-recent',
  maxContextMessages: 6,
  conversationSummary: '',
  currentRequestId: null,
  isSummarizing: false,

  loadProviders: async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.getAIProviders();
    if (result.success && result.data) {
      const activeProvider = result.data.providers.find((p) => p.isActive);
      set({
        providers: result.data.providers,
        activeProviderId: activeProvider?.id || null,
      });
    }
  },

  saveProvider: async (provider: AIProviderConfig) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.saveAIProvider(provider);
    if (result.success) {
      await get().loadProviders();
    }
  },

  deleteProvider: async (providerId: string) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.deleteAIProvider(providerId);
    if (result.success) {
      await get().loadProviders();
    }
  },

  setActiveProvider: (providerId: string | null) => {
    set({ activeProviderId: providerId, isLoading: false, error: null });
  },

  sendMessage: async (content: string) => {
    if (!window.electronAPI) return;
    const { activeProviderId, messages, contextStrategy, conversationSummary, maxContextMessages } = get();
    if (!activeProviderId) return;

    const requestId = `chat-${Date.now()}`;
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
      isLoading: true,
      error: null,
      currentRequestId: requestId,
    }));

    const allMessages = buildChatContext({
      messages,
      userMessage,
      contextStrategy,
      conversationSummary,
      maxContextMessages,
      terminalContext: collectTerminalContext(),
    });

    try {
      const result = await window.electronAPI.aiChat(activeProviderId, allMessages, { requestId });
      if (!result.success) {
        set({
          isLoading: false,
          currentRequestId: null,
          error: formatAIErrorMessage(result.error || t('aiErrors.defaultError'), result.code),
        });
        return;
      }

      const response: AIChatResponse = result.data;
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.content || '',
        timestamp: Date.now(),
      };

      set((state) => ({
        messages: [...state.messages, assistantMessage],
        isLoading: false,
        currentRequestId: null,
      }));

      void get().maybeRefreshSummary();

      const currentMessages = get().messages;
      if (contextStrategy === 'keep-recent' && currentMessages.length > maxContextMessages * 2) {
        get().trimContext();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('aiErrors.defaultError');
      set({
        isLoading: false,
        currentRequestId: null,
        error: formatAIErrorMessage(message),
      });
    }
  },

  cancelMessage: async () => {
    const requestId = get().currentRequestId;
    if (!window.electronAPI || !requestId) return;
    await window.electronAPI.cancelAIChat(requestId);
    set({ isLoading: false, currentRequestId: null, error: t('aiErrors.canceled') });
  },

  addMessage: (message: Message) => {
    set((state) => ({
      messages: [...state.messages, message],
    }));
  },

  clearMessages: () => {
    set({
      messages: [],
      error: null,
      isLoading: false,
      conversationSummary: '',
      currentRequestId: null,
    });
  },

  clearError: () => {
    set({ error: null });
  },

  analyzeCommand: (command: string): CommandSuggestion => {
    return riskAnalysisToSuggestion(command);
  },

  getContextMessages: () => {
    const { messages, contextStrategy, maxContextMessages, conversationSummary } = get();
    return buildChatContext({
      messages: messages.slice(0, -1),
      userMessage: messages[messages.length - 1] || { id: 'preview', role: 'user', content: '', timestamp: Date.now() },
      contextStrategy,
      conversationSummary,
      maxContextMessages,
      terminalContext: collectTerminalContext(),
    });
  },

  setContextStrategy: (strategy: ContextStrategy) => {
    set({ contextStrategy: strategy });
  },

  setMaxContextMessages: (max: number) => {
    set({ maxContextMessages: Math.max(2, Math.min(50, max)) });
  },

  trimContext: () => {
    const { messages, maxContextMessages } = get();
    if (messages.length <= maxContextMessages) return;
    set({ messages: messages.slice(-maxContextMessages) });
  },

  updateSummary: (summary: string) => {
    set({ conversationSummary: trimText(summary, SUMMARY_MAX_LENGTH) });
  },

  maybeRefreshSummary: async () => {
    const { messages, contextStrategy, activeProviderId, isSummarizing } = get();
    if (contextStrategy !== 'keep-summary' || messages.length < SUMMARY_TRIGGER_THRESHOLD) {
      return;
    }
    // 无 provider 或正在摘要时，回退到机械摘要以保证有内容
    if (isSummarizing || !activeProviderId || !window.electronAPI) {
      if (!get().conversationSummary) {
        get().updateSummary(summarizeMessages(messages));
      }
      return;
    }

    // 保留最近若干条不摘要，其余压缩为语义摘要
    const toSummarize = messages.slice(0, -SUMMARY_KEEP_RECENT);
    if (toSummarize.length === 0) {
      return;
    }

    set({ isSummarizing: true });
    try {
      // 调用 AI 生成语义摘要
      const summaryMessages: Message[] = [
        { id: 'summary-system', role: 'system', content: SUMMARY_SYSTEM_PROMPT, timestamp: Date.now() },
        {
          id: 'summary-user',
          role: 'user',
          content: buildSummaryInput(toSummarize, get().conversationSummary),
          timestamp: Date.now(),
        },
      ];
      const result = await window.electronAPI.aiChat(activeProviderId, summaryMessages, {
        requestId: `summary-${Date.now()}`,
      });
      if (result.success && result.data?.content) {
        get().updateSummary(result.data.content);
      } else if (!get().conversationSummary) {
        get().updateSummary(summarizeMessages(messages));
      }
    } catch {
      // 摘要失败不影响主对话流程，必要时回退机械摘要
      if (!get().conversationSummary) {
        get().updateSummary(summarizeMessages(get().messages));
      }
    } finally {
      set({ isSummarizing: false });
    }
  },

  extractCommand: (aiResponse: string): string | null => {
    return extractCommand(aiResponse);
  },
}));
