import type { AppSettings } from '../../shared/types';
import type { Session } from '../../shared/types';
import { SessionTerminal } from '../session/SessionTerminal';
import { SftpSidebar } from '../transfer/SftpSidebar';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import { WorkspaceLayout } from './WorkspaceLayout';

export interface WorkspaceTab {
  id: string;
  name: string;
  isConnected: boolean;
  isConnecting: boolean;
  lastError?: string;
  restoredFromScrollback?: boolean;
  state?: Session['state'];
}

interface SessionWorkspaceProps {
  activeTabId: string | null;
  tabs: WorkspaceTab[];
  isSftpSidebarOpen: boolean;
  onPasteToAI: (text: string) => void;
  onCloseSftpSidebar: () => void;
  theme: 'dark' | 'light' | 'system';
  settings: AppSettings;
  onSettingsPatch?: (patch: Partial<AppSettings>) => void | Promise<void>;
}

/** Renders the active session terminal and its session-bound SFTP sidebar. */
export function SessionWorkspace({
  activeTabId,
  tabs,
  isSftpSidebarOpen,
  onPasteToAI,
  onCloseSftpSidebar,
  theme,
  settings,
  onSettingsPatch,
}: SessionWorkspaceProps) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  // 侧栏绑定活动标签；断线时仍保留会话上下文，方便查看任务与上次路径
  const activeConnectionId = activeTab?.id ?? null;
  const isLive = Boolean(activeTab?.isConnected);

  const sidebar = isSftpSidebarOpen ? (
    <SftpSidebar
      connectionId={activeConnectionId}
      isLive={isLive}
      onClose={onCloseSftpSidebar}
    />
  ) : null;

  return (
    <WorkspaceLayout sidebar={sidebar}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="absolute inset-0 flex flex-col"
          style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
        >
          <SessionTerminal
            liveConnectionId={tab.isConnected ? tab.id : null}
            sessionId={tab.id}
            onPasteToAI={onPasteToAI}
            theme={theme}
            settings={settings}
            onSettingsPatch={onSettingsPatch}
          />
        </div>
      ))}
      {tabs.length === 0 && <WorkspaceEmptyState />}
    </WorkspaceLayout>
  );
}
