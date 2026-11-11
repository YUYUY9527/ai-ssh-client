import { create } from 'zustand';
import type { ConnectionGroup } from '../../shared/types';

interface ConnectionGroupState {
  groups: ConnectionGroup[];
  /** 当前环境是否支持连接分组（Web 已实现；桌面端方法缺失时为 false，UI 自动隐藏）。 */
  supported: boolean;
  loadGroups: () => Promise<void>;
  saveGroup: (group: ConnectionGroup) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
}

export const useConnectionGroupStore = create<ConnectionGroupState>((set, get) => ({
  groups: [],
  supported: typeof window !== 'undefined'
    && typeof window.electronAPI?.getConnectionGroups === 'function',

  loadGroups: async () => {
    const api = window.electronAPI?.getConnectionGroups;
    if (!api) {
      set({ supported: false, groups: [] });
      return;
    }
    const result = await api();
    if (result.success && result.data) {
      set({ supported: true, groups: result.data.groups || [] });
    }
  },

  saveGroup: async (group) => {
    const api = window.electronAPI?.saveConnectionGroup;
    if (!api) return;
    const result = await api(group);
    if (result.success) {
      await get().loadGroups();
    }
  },

  deleteGroup: async (groupId) => {
    const api = window.electronAPI?.deleteConnectionGroup;
    if (!api) return;
    const result = await api(groupId);
    if (result.success) {
      await get().loadGroups();
    }
  },
}));