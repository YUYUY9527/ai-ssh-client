import { create } from 'zustand';

import type { CommandHistoryIndex, CommandHistoryItem } from '../../shared/types';
import {
  buildCommandHistoryIndex,
  buildCommandHistoryTree,
  enrichHistoryItems,
  getRecentCommandsForContext,
  prioritizeHistoryTree,
  queryCommandHistory,
  type CommandHistoryContext,
  type CommandHistoryHostNode,
  type CommandHistoryItemView,
} from './command-history-index';

interface CommandHistoryStoreState {
  items: CommandHistoryItem[];
  views: CommandHistoryItemView[];
  index: CommandHistoryIndex[];
  tree: CommandHistoryHostNode[];
  isLoading: boolean;
  loadedAt: number | null;
  loadHistory: (force?: boolean) => Promise<void>;
  addHistoryItem: (item: CommandHistoryItem) => Promise<void>;
  clearHistory: () => Promise<void>;
  getTree: (context?: CommandHistoryContext) => CommandHistoryHostNode[];
  query: (options?: {
    context?: CommandHistoryContext;
    search?: string;
    limit?: number;
    preferCurrentContext?: boolean;
  }) => CommandHistoryItemView[];
  getSuggestions: (context?: CommandHistoryContext, limit?: number) => string[];
}

function materialize(items: CommandHistoryItem[]) {
  const views = enrichHistoryItems(items);
  return {
    items,
    views,
    index: buildCommandHistoryIndex(items),
    tree: buildCommandHistoryTree(items),
  };
}

/** Central command history store used by history-related UI and terminal tracking. */
export const useCommandHistoryStore = create<CommandHistoryStoreState>((set, get) => ({
  items: [],
  views: [],
  index: [],
  tree: [],
  isLoading: false,
  loadedAt: null,

  loadHistory: async (force = false) => {
    if (!window.electronAPI) {
      return;
    }

    const state = get();
    if (!force && state.isLoading) {
      return;
    }
    // 短时间内重复打开面板时复用缓存，避免频繁 IPC
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 1500) {
      return;
    }

    set({ isLoading: true });
    try {
      const result = await window.electronAPI.getCommandHistory();
      if (!result.success) {
        return;
      }

      const items = Array.isArray(result.data?.history) ? result.data.history : [];
      set({
        ...materialize(items),
        loadedAt: Date.now(),
      });
    } finally {
      set({ isLoading: false });
    }
  },

  addHistoryItem: async (item) => {
    // 乐观更新：先写入本地索引，再异步落盘
    const nextItems = [item, ...get().items.filter((existing) => existing.id !== item.id)].slice(0, 500);
    set({
      ...materialize(nextItems),
      loadedAt: Date.now(),
    });

    if (!window.electronAPI) {
      window.dispatchEvent(new CustomEvent('command-history-updated'));
      return;
    }

    await window.electronAPI.addCommandHistory(item);
    window.dispatchEvent(new CustomEvent('command-history-updated'));
    await get().loadHistory(true);
  },

  clearHistory: async () => {
    if (window.electronAPI) {
      await window.electronAPI.clearCommandHistory();
    }
    set({
      ...materialize([]),
      loadedAt: Date.now(),
    });
    window.dispatchEvent(new CustomEvent('command-history-updated'));
  },

  getTree: (context) => prioritizeHistoryTree(get().tree, context),

  query: (options) => queryCommandHistory(get().items, options),

  getSuggestions: (context, limit = 20) => getRecentCommandsForContext(get().items, context, limit),
}));
