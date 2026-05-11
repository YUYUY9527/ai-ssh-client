import { create } from 'zustand';
import type { AIProviderConfig, AIProviderSummary, Message, CommandSuggestion } from '../../shared/types';
import type { AIChatResponse } from '../../shared/ipc-types';
import { extractCommand, riskAnalysisToSuggestion } from '../ai';

export type ContextStrategy = 'keep-all' | 'keep-recent' | 'keep-summary';

const SUMMARY_TRIGGER_THRESHOLD = 10;
const SUMMARY_MAX_LENGTH = 1200;

function trimText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeMessages(messages: Message[]): string {
  return messages
    .slice(-6)
    .map((message) => `${message.role}: ${trimText(message.content.replace(/\s+/g, ' '), 120)}`)
    .join('\n');
}

function estimateMessageCost(message: Message): number {
  return message.content.length + 20;
}

function formatAIErrorMessage(message: string, code?: string): string {
  const normalized = `${code || ''} ${message}`.toLowerCase();

  if (normalized.includes('provider_not_found') || normalized.includes('not found or not active')) {
    return '当前 AI 供应商不可用，请确认已正确激活。';
  }
  if (normalized.includes('缺少 api key') || normalized.includes('auth') || normalized.includes('401') || normalized.includes('403')) {
    return '鉴权失败，请检查 API Key 是否正确、是否过期。';
  }
  if (normalized.includes('timeout') || normalized.includes('超时')) {
    return '请求超时，请检查网络状态或稍后重试。';
  }
  if (normalized.includes('429') || normalized.includes('rate')) {
    return '请求过于频繁，请稍后再试或切换模型。';
  }
  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('failed to fetch')) {
    return '网络请求失败，请检查 API 地址和网络连接。';
  }
  if (normalized.includes('invalid_response') || normalized.includes('响应格式无效')) {
    return 'AI 返回了无法解析的结果，请重试或切换模型。';
  }
  if (normalized.includes('invalid_config')) {
    return 'AI 供应商配置无效，请检查地址、模型和密钥配置。';
  }

  return message || 'AI 响应失败，请稍后重试';
}

function buildChatContext(params: {
  messages: Message[];
  userMessage: Message;
  contextStrategy: ContextStrategy;
  conversationSummary: string;
  maxContextMessages: number;
}): Message[] {
  const { messages, userMessage, contextStrategy, conversationSummary, maxContextMessages } = params;

  let systemPrompt = `你是一个专业的Linux系统管理员助手。请简洁地回答用户关于Linux命令的问题。

回复格式要求（必须严格遵守）：
1. 每行一个命令，格式：- 命令：说明
2. 命令部分在前，用冒号分隔，说明在后
3. 不要代码块，不要序号，不要多余开场白或总结`;

  if (contextStrategy === 'keep-summary' && conversationSummary) {
    systemPrompt = `【对话摘要】\n${conversationSummary}\n\n---\n\n${systemPrompt}`;
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
  maybeRefreshSummary: () => void;
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
    });

    try {
      const result = await window.electronAPI.aiChat(activeProviderId, allMessages, { requestId });
      if (!result.success) {
        set({
          isLoading: false,
          currentRequestId: null,
          error: formatAIErrorMessage(result.error || 'AI 响应失败，请稍后重试', result.code),
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

      get().maybeRefreshSummary();

      const currentMessages = get().messages;
      if (contextStrategy === 'keep-recent' && currentMessages.length > maxContextMessages * 2) {
        get().trimContext();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 响应失败，请稍后重试';
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
    set({ isLoading: false, currentRequestId: null, error: '已取消当前请求' });
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

  maybeRefreshSummary: () => {
    const { messages, contextStrategy } = get();
    if (contextStrategy !== 'keep-summary' || messages.length < SUMMARY_TRIGGER_THRESHOLD) {
      return;
    }
    get().updateSummary(summarizeMessages(messages));
  },

  extractCommand: (aiResponse: string): string | null => {
    return extractCommand(aiResponse);
  },
}));
