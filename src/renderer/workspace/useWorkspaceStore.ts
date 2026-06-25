import { create } from 'zustand';

interface WorkspaceStoreState {
  isSftpSidebarOpen: boolean;
  isAssistantOpen: boolean;
  setSftpSidebarOpen: (isOpen: boolean) => void;
  toggleSftpSidebar: () => void;
  setAssistantOpen: (isOpen: boolean) => void;
}

/** Stores workspace layout state separate from session runtime data. */
export const useWorkspaceStore = create<WorkspaceStoreState>((set) => ({
  isSftpSidebarOpen: false,
  isAssistantOpen: false,
  setSftpSidebarOpen: (isSftpSidebarOpen) => set({ isSftpSidebarOpen }),
  toggleSftpSidebar: () => set((state) => ({ isSftpSidebarOpen: !state.isSftpSidebarOpen })),
  setAssistantOpen: (isAssistantOpen) => set({ isAssistantOpen }),
}));
