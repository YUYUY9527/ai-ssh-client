import { create } from 'zustand';

import type { CommandHistoryIndex, CommandHistoryItem } from '../../shared/types';
import { buildCommandHistoryIndex } from './command-history-index';

interface CommandHistoryStoreState {
  items: CommandHistoryItem[];
  index: CommandHistoryIndex[];
  loadHistory: () => Promise<void>;
  addHistoryItem: (item: CommandHistoryItem) => Promise<void>;
}

/** Central command history store used by history-related UI. */
export const useCommandHistoryStore = create<CommandHistoryStoreState>((set, get) => ({
  items: [],
  index: [],

  loadHistory: async () => {
    if (!window.electronAPI) {
      return;
    }

    const result = await window.electronAPI.getCommandHistory();
    if (!result.success) {
      return;
    }

    const items = Array.isArray(result.data?.history) ? result.data.history : [];
    set({
      items,
      index: buildCommandHistoryIndex(items),
    });
  },

  addHistoryItem: async (item) => {
    if (!window.electronAPI) {
      return;
    }

    await window.electronAPI.addCommandHistory(item);
    await get().loadHistory();
  },
}));
