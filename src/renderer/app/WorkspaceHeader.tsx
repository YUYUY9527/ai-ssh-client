import { useEffect, useState } from 'react';
import type { DragEvent, RefObject } from 'react';
import {
  Edit3,
  FolderUp,
  GripVertical,
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
import { useConnectionStore } from '../store/useConnectionStore';
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
  const reorderConnections = useConnectionStore((state) => state.reorderConnections);
  const [connectionQuery, setConnectionQuery] = useState('');
  const [draggedConnectionId, setDraggedConnectionId] = useState<string | null>(null);
  const [dragOverConnectionId, setDragOverConnectionId] = useState<string | null>(null);
  const normalizedQuery = connectionQuery.trim().toLowerCase();
  // 按名称/主机/用户名过滤连接，便于在大量连接中快速定位
  const filteredConnections = normalizedQuery
    ? connections.filter((connection) =>
        `${connection.name} ${connection.username} ${connection.host}`
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : connections;
  // 连接较多时才显示搜索框，避免少量连接时的冗余
  const showConnectionSearch = connections.length > 5;
  // 搜索过滤中禁用拖拽，避免只对子集排序导致全表错乱
  const canReorder = !normalizedQuery && connections.length > 1;

  // 下拉关闭时清空搜索词与拖拽态
  useEffect(() => {
    if (!isConnectionDropdownOpen) {
      setConnectionQuery('');
      setDraggedConnectionId(null);
      setDragOverConnectionId(null);
    }
  }, [isConnectionDropdownOpen]);

  /** 开始拖动连接项 */
  const handleConnectionDragStart = (event: DragEvent, connectionId: string) => {
    if (!canReorder) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', connectionId);
    setDraggedConnectionId(connectionId);
  };

  /** 拖到目标项上方时高亮插入位置 */
  const handleConnectionDragOver = (event: DragEvent, connectionId: string) => {
    if (!canReorder || !draggedConnectionId || draggedConnectionId === connectionId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverConnectionId(connectionId);
  };

  const handleConnectionDragLeave = () => {
    setDragOverConnectionId(null);
  };

  /** 放到目标项上：把拖动项插到目标位置并持久化 */
  const handleConnectionDrop = (event: DragEvent, targetId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain') || draggedConnectionId;
    setDraggedConnectionId(null);
    setDragOverConnectionId(null);
    if (!sourceId || sourceId === targetId || !canReorder) {
      return;
    }
    const ids = connections.map((item) => item.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      return;
    }
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void reorderConnections(next);
  };

  const handleConnectionDragEnd = () => {
    setDraggedConnectionId(null);
    setDragOverConnectionId(null);
  };

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
              {showConnectionSearch && (
                <div className="px-2 pb-2 pt-1">
                  <input
                    type="text"
                    value={connectionQuery}
                    onChange={(event) => setConnectionQuery(event.target.value)}
                    placeholder={translate('connection.searchPlaceholder')}
                    className="industrial-input w-full text-sm"
                    autoFocus
                  />
                </div>
              )}
              {connections.length === 0 ? (
                <div className="p-4 text-center text-slate-500 dark:text-slate-400 text-sm">
                  {translate('connection.noConnections')}
                </div>
              ) : filteredConnections.length === 0 ? (
                <div className="p-4 text-center text-slate-500 dark:text-slate-400 text-sm">
                  {translate('connection.noMatches')}
                </div>
              ) : (
                <>
                  {canReorder && (
                    <div className="px-3 pb-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {translate('connection.dragToReorder')}
                    </div>
                  )}
                  {filteredConnections.map((connection) => (
                    <div
                      key={connection.id}
                      draggable={canReorder}
                      onDragStart={(event) => handleConnectionDragStart(event, connection.id)}
                      onDragOver={(event) => handleConnectionDragOver(event, connection.id)}
                      onDragLeave={handleConnectionDragLeave}
                      onDrop={(event) => handleConnectionDrop(event, connection.id)}
                      onDragEnd={handleConnectionDragEnd}
                      className={`group mx-2 my-1 flex items-center rounded-sm border px-2 py-2 transition-colors ${
                        dragOverConnectionId === connection.id
                          ? 'border-teal-500 bg-teal-500/10 ring-1 ring-teal-400/50'
                          : 'border-[color-mix(in_srgb,var(--border-color)_68%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]'
                      } ${
                        draggedConnectionId === connection.id ? 'opacity-50' : ''
                      } ${canReorder ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    >
                      {canReorder && (
                        <span
                          className="mr-1 flex h-7 w-4 shrink-0 items-center justify-center text-slate-400"
                          title={translate('connection.dragToReorder')}
                          aria-hidden
                        >
                          <GripVertical className="h-4 w-4" />
                        </span>
                      )}
                      <button
                        onClick={() => onConnect(connection.id, connection.name)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-teal-500/40 bg-teal-500/10">
                          <Server className="w-4 h-4 text-teal-500" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
                            {connection.name}
                          </div>
                          <div className="text-xs text-slate-500">
                            {connection.username}@{connection.host}:{connection.port}
                          </div>
                        </div>
                      </button>
                      <div className="hidden items-center gap-1 group-hover:flex">
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
                  ))}
                </>
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
        {activeTabId && (
          <CommandHistoryPanel
            onPasteCommand={onPasteCommand}
            activeSessionId={activeTabId}
          />
        )}
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
