import { create } from 'zustand';
import type { AIProviderConfig, AIProviderSummary, CommandSuggestion } from '../../shared/types';
import { extractCommand, riskAnalysisToSuggestion } from '../ai';

/**
 * AI provider + command risk helpers for the SSH Agent product surface.
 * Ordinary multi-turn chat UI was removed; keep this store lean.
 */
interface AIState {
  providers: AIProviderSummary[];
  activeProviderId: string | null;

  loadProviders: () => Promise<void>;
  saveProvider: (provider: AIProviderConfig) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  setActiveProvider: (providerId: string | null) => void;
  analyzeCommand: (command: string) => CommandSuggestion;
  extractCommand: (aiResponse: string) => string | null;
}

export const useAIStore = create<AIState>((set, get) => ({
  providers: [],
  activeProviderId: null,

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
    set({ activeProviderId: providerId });
  },

  // 命令风险分析，供 Agent / 审批弹窗使用
  analyzeCommand: (command: string): CommandSuggestion => {
    return riskAnalysisToSuggestion(command);
  },

  extractCommand: (aiResponse: string): string | null => {
    return extractCommand(aiResponse);
  },
}));
