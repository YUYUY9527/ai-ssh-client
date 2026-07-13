import { create } from 'zustand';

import {
  DEFAULT_SFTP_SIDEBAR_WIDTH,
  SFTP_SIDEBAR_MAX_WIDTH,
  SFTP_SIDEBAR_MIN_WIDTH,
} from '../transfer/transfer-types';

interface WorkspaceStoreState {
  isSftpSidebarOpen: boolean;
  sftpSidebarWidth: number;
  isAssistantOpen: boolean;
  setSftpSidebarOpen: (isOpen: boolean) => void;
  toggleSftpSidebar: () => void;
  setSftpSidebarWidth: (width: number) => void;
  setAssistantOpen: (isOpen: boolean) => void;
}

function clampSidebarWidth(width: number): number {
  return Math.max(SFTP_SIDEBAR_MIN_WIDTH, Math.min(SFTP_SIDEBAR_MAX_WIDTH, Math.round(width)));
}

/** Stores workspace layout state separate from session runtime data. */
export const useWorkspaceStore = create<WorkspaceStoreState>((set) => ({
  isSftpSidebarOpen: false,
  sftpSidebarWidth: DEFAULT_SFTP_SIDEBAR_WIDTH,
  isAssistantOpen: false,
  setSftpSidebarOpen: (isSftpSidebarOpen) => set({ isSftpSidebarOpen }),
  toggleSftpSidebar: () => set((state) => ({ isSftpSidebarOpen: !state.isSftpSidebarOpen })),
  setSftpSidebarWidth: (width) => set({ sftpSidebarWidth: clampSidebarWidth(width) }),
  setAssistantOpen: (isAssistantOpen) => set({ isAssistantOpen }),
}));
