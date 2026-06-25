import type { RefObject } from 'react';
import {
  Edit3,
  FolderUp,
  Monitor,
  Moon,
  Plug,
  Plus,
  Server,
  Settings,
  Sun,
  Trash2,
} from 'lucide-react';

import { AppIcon } from '../components/AppIcon';
import { CommandHistoryPanel } from '../history/CommandHistoryPanel';
import { QuickCommandsPanel } from '../components/QuickCommandsPanel';
import type { SSHConnection } from '../../shared/types';

interface WorkspaceHeaderProps {
  activeTabId: string | null;
  connections: SSHConnection[];
  connectionDropdownRef: RefObject<HTMLDivElement>;
  isConnectionDropdownOpen: boolean;
  isSettingsOpen: boolean;
  isSftpSidebarOpen: boolean;
  theme: 'dark' | 'light' | 'system';
  translate: (key: string, params?: Record<string, string | number>) => string;
  onChangeTheme: (theme: 'dark' | 'light' | 'system') => void;
  onConnect: (connectionId: string, connectionName: string) => void;
  onCreateConnection: () => void;
  onDeleteConnection: (connectionId: string) => void;
  onEditConnection: (connection: SSHConnection) => void;
  onPasteCommand: (command: string) => void;
  onToggleConnectionDropdown: () => void;
  onToggleSettings: () => void;
  onToggleSftpSidebar: () => void;
}

/** Top workspace toolbar with connection, SFTP, command and settings controls. */
export function WorkspaceHeader({
  activeTabId,
  connections,
  connectionDropdownRef,
  isConnectionDropdownOpen,
  isSettingsOpen,
  isSftpSidebarOpen,
  theme,
  translate,
  onChangeTheme,
  onConnect,
  onCreateConnection,
  onDeleteConnection,
  onEditConnection,
  onPasteCommand,
  onToggleConnectionDropdown,
  onToggleSettings,
  onToggleSftpSidebar,
}: WorkspaceHeaderProps) {
  return (
    <header className="app-header">
      <div className="flex items-center gap-2">
        <div className="app-title-mark">
          <AppIcon className="h-6 w-6" />
        </div>
        <div className="mr-2 leading-tight">
          <h1 className="text-sm font-semibold tracking-wide">AI SSH Client</h1>
          <p className="text-[10px] uppercase text-slate-500 dark:text-slate-500">
            secure shell workspace
          </p>
        </div>

        <div className="relative" ref={connectionDropdownRef}>
          <button
            onClick={onToggleConnectionDropdown}
            className="toolbar-button-primary"
          >
            <Plug className="w-4 h-4" />
            {translate('connection.connect')}
          </button>
          {isConnectionDropdownOpen && (
            <div className="app-popover left-0 w-80 scrollbar-modern">
              <div className="app-popover-header">
                <span>{translate('connection.selectConnection')}</span>
                <button
                  onClick={onCreateConnection}
                  className="icon-button h-7 w-7"
                  title={translate('connection.newConnection')}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              {connections.length === 0 ? (
                <div className="p-4 text-center text-slate-500 dark:text-slate-400 text-sm">
                  {translate('connection.noConnections')}
                </div>
              ) : (
                connections.map((connection) => (
                  <div
                    key={connection.id}
                    className="group mx-2 my-1 flex items-center rounded-sm border border-[color-mix(in_srgb,var(--border-color)_68%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] px-2 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
                  >
                    <button
                      onClick={() => onConnect(connection.id, connection.name)}
                      className="flex-1 flex items-center gap-2 text-left"
                    >
                      <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-teal-500/40 bg-teal-500/10">
                        <Server className="w-4 h-4 text-teal-500" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-slate-900 dark:text-white truncate">
                          {connection.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {connection.username}@{connection.host}:{connection.port}
                        </div>
                      </div>
                    </button>
                    <div className="hidden group-hover:flex items-center gap-1">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditConnection(connection);
                        }}
                        className="icon-button h-7 w-7"
                        title={translate('common.edit')}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteConnection(connection.id);
                        }}
                        className="icon-button h-7 w-7 hover:text-red-500 dark:hover:text-red-400"
                        title={translate('common.delete')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {activeTabId && (
          <button
            onClick={onToggleSftpSidebar}
            className={`toolbar-button ${isSftpSidebarOpen ? 'toolbar-button-active' : ''}`}
            title={translate('fileTransfer.transfer')}
          >
            <FolderUp className="w-4 h-4" />
            {translate('fileTransfer.transfer')}
          </button>
        )}

        {activeTabId && <QuickCommandsPanel onPasteCommand={onPasteCommand} />}
        {activeTabId && <CommandHistoryPanel onPasteCommand={onPasteCommand} />}
      </div>

      <div className="flex items-center gap-2">
        <div className="toolbar-group">
          <button
            onClick={() => onChangeTheme('light')}
            className={`icon-button h-7 w-7 ${theme === 'light' ? 'icon-button-active' : ''}`}
            title={translate('theme.light')}
          >
            <Sun className="w-4 h-4" />
          </button>
          <button
            onClick={() => onChangeTheme('dark')}
            className={`icon-button h-7 w-7 ${theme === 'dark' ? 'icon-button-active' : ''}`}
            title={translate('theme.dark')}
          >
            <Moon className="w-4 h-4" />
          </button>
          <button
            onClick={() => onChangeTheme('system')}
            className={`icon-button h-7 w-7 ${theme === 'system' ? 'icon-button-active' : ''}`}
            title={translate('theme.system')}
          >
            <Monitor className="w-4 h-4" />
          </button>
        </div>
        <button
          onClick={onToggleSettings}
          className={`icon-button ${isSettingsOpen ? 'icon-button-active' : ''}`}
          title={translate('settings.title')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
