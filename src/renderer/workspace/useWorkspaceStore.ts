import { create } from 'zustand';

import {
  DEFAULT_SFTP_SIDEBAR_WIDTH,
  SFTP_SIDEBAR_MAX_WIDTH,
  SFTP_SIDEBAR_MIN_WIDTH,
} from '../transfer/transfer-types';
import {
  MAX_PANES,
  collectLeaves,
  countLeaves,
  createSplit,
  removeLeaf,
  replaceLeaf,
  setSplitRatio,
  splitLeaf,
  swapLeaves,
  type PaneNode,
  type PaneSide,
  type SplitOrientation,
} from './paneLayout';

export const SPLIT_MIN_RATIO = 0.2;
export const SPLIT_MAX_RATIO = 0.8;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(SPLIT_MIN_RATIO, Math.min(SPLIT_MAX_RATIO, ratio));
}

interface WorkspaceStoreState {
  isSftpSidebarOpen: boolean;
  sftpSidebarWidth: number;
  isAssistantOpen: boolean;
  /** 分屏布局树；null 表示单面板（跟随当前活动会话全屏显示）。 */
  paneRoot: PaneNode | null;
  setSftpSidebarOpen: (isOpen: boolean) => void;
  toggleSftpSidebar: () => void;
  setSftpSidebarWidth: (width: number) => void;
  setAssistantOpen: (isOpen: boolean) => void;
  /** 把 newTabId 会话分割到 targetTabId 面板的指定一侧；超过上限返回 false。 */
  splitPane: (targetTabId: string, newTabId: string, side: PaneSide) => boolean;
  /** 用 newTabId 替换 targetTabId 所在面板。 */
  replacePane: (targetTabId: string, newTabId: string) => void;
  /** 交换两个已显示会话所在的面板位置。 */
  swapPanes: (aTabId: string, bTabId: string) => void;
  /** 移除某个会话所在面板（会话关闭时调用），必要时收起多余分割。 */
  removePane: (tabId: string) => void;
  setSplitRatioById: (id: string, ratio: number) => void;
  resetLayout: () => void;
  /** 清理掉已经关闭的会话面板。 */
  prunePanes: (openTabIds: string[]) => void;
}

function clampSidebarWidth(width: number): number {
  return Math.max(SFTP_SIDEBAR_MIN_WIDTH, Math.min(SFTP_SIDEBAR_MAX_WIDTH, Math.round(width)));
}

/** Stores workspace layout state separate from session runtime data. */
export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  isSftpSidebarOpen: false,
  sftpSidebarWidth: DEFAULT_SFTP_SIDEBAR_WIDTH,
  isAssistantOpen: false,
  paneRoot: null,
  setSftpSidebarOpen: (isSftpSidebarOpen) => set({ isSftpSidebarOpen }),
  toggleSftpSidebar: () => set((state) => ({ isSftpSidebarOpen: !state.isSftpSidebarOpen })),
  setSftpSidebarWidth: (width) => set({ sftpSidebarWidth: clampSidebarWidth(width) }),
  setAssistantOpen: (isAssistantOpen) => set({ isAssistantOpen }),

  splitPane: (targetTabId, newTabId, side) => {
    if (!targetTabId || !newTabId || targetTabId === newTabId) return false;
    const existing = collectLeaves(get().paneRoot);
    if (existing.includes(newTabId)) {
      // 已经显示的会话不重复分割，避免同一个会话出现在两个面板
      return false;
    }
    if (countLeaves(get().paneRoot) >= MAX_PANES) {
      // 已达 4 面板上限：退化为替换目标面板
      set((state) => ({ paneRoot: replaceLeaf(state.paneRoot, targetTabId, newTabId) }));
      return false;
    }
    const root = get().paneRoot;
    let next: PaneNode | null;
    if (!root) {
      const orientation: SplitOrientation = side === 'left' || side === 'right' ? 'row' : 'column';
      const first: PaneNode = side === 'left' || side === 'top'
        ? { type: 'leaf', tabId: newTabId }
        : { type: 'leaf', tabId: targetTabId };
      const second: PaneNode = side === 'left' || side === 'top'
        ? { type: 'leaf', tabId: targetTabId }
        : { type: 'leaf', tabId: newTabId };
      next = createSplit(orientation, first, second);
    } else {
      const result = splitLeaf(root, targetTabId, newTabId, side);
      if (!result) return false;
      next = result.node;
    }
    set({ paneRoot: next });
    return true;
  },

  replacePane: (targetTabId, newTabId) => set((state) => {
    if (!state.paneRoot || targetTabId === newTabId) return {};
    return { paneRoot: replaceLeaf(state.paneRoot, targetTabId, newTabId) };
  }),

  swapPanes: (aTabId, bTabId) => set((state) => {
    if (!state.paneRoot || !aTabId || !bTabId || aTabId === bTabId) return {};
    const leaves = collectLeaves(state.paneRoot);
    if (!leaves.includes(aTabId) || !leaves.includes(bTabId)) return {};
    return { paneRoot: swapLeaves(state.paneRoot, aTabId, bTabId) };
  }),

  removePane: (tabId) => set((state) => {
    if (!state.paneRoot) return {};
    const next = removeLeaf(state.paneRoot, tabId);
    // 只剩一个面板时回到「单面板跟随活动会话」
    return { paneRoot: countLeaves(next) <= 1 ? null : next };
  }),

  setSplitRatioById: (id, ratio) => set((state) => ({
    paneRoot: setSplitRatio(state.paneRoot, id, clampSplitRatio(ratio)),
  })),

  resetLayout: () => set({ paneRoot: null }),

  prunePanes: (openTabIds) => set((state) => {
    if (!state.paneRoot) return {};
    const open = new Set(openTabIds);
    let root: PaneNode | null = state.paneRoot;
    for (const tabId of collectLeaves(root)) {
      if (!open.has(tabId)) {
        root = removeLeaf(root, tabId);
      }
    }
    return { paneRoot: countLeaves(root) <= 1 ? null : root };
  }),
}));
