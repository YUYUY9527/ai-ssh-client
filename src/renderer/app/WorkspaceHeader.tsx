import { lazy, Suspense, useEffect, useState } from 'react';
import type { DragEvent, RefObject } from 'react';
import {
  Check,
  ChevronRight,
  Download,
  Edit3,
  Folder,
  FolderPlus,
  GripVertical,
  Monitor,
  Moon,
  Pencil,
  Plug,
  Plus,
  Server,
  Settings,
  Sun,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { AppIcon } from '../components/AppIcon';
import { useAIStore } from '../store/useAIStore';
import { useConnectionStore } from '../store/useConnectionStore';
import { useConnectionGroupStore } from '../store/useConnectionGroupStore';
import { ConfirmDialog } from '../shared-ui/ConfirmDialog';
import type { ConnectionGroup, SSHConnection } from '../../shared/types';

const ConnectionImportExportModal = lazy(async () => {
  const module = await import('../connection/ConnectionImportExportModal');
  return { default: module.ConnectionImportExportModal };
});
const CommandHistoryPanel = lazy(async () => {
  const module = await import('../history/CommandHistoryPanel');
  return { default: module.CommandHistoryPanel };
});
const QuickCommandsPanel = lazy(async () => {
  const module = await import('../components/QuickCommandsPanel');
  return { default: module.QuickCommandsPanel };
});

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
  const loadConnections = useConnectionStore((state) => state.loadConnections);
  const loadProviders = useAIStore((state) => state.loadProviders);
  const groups = useConnectionGroupStore((state) => state.groups);
  const groupsSupported = useConnectionGroupStore((state) => state.supported);
  const loadGroups = useConnectionGroupStore((state) => state.loadGroups);
  const saveGroup = useConnectionGroupStore((state) => state.saveGroup);
  const deleteGroup = useConnectionGroupStore((state) => state.deleteGroup);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupModal, setGroupModal] = useState<{
    open: boolean;
    editing: ConnectionGroup | null;
    name: string;
  }>({ open: false, editing: null, name: '' });
  const [groupToDelete, setGroupToDelete] = useState<ConnectionGroup | null>(null);
  const [connectionQuery, setConnectionQuery] = useState('');
  const [draggedConnectionId, setDraggedConnectionId] = useState<string | null>(null);
  const [dragOverConnectionId, setDragOverConnectionId] = useState<string | null>(null);
  const [importExportMode, setImportExportMode] = useState<'export' | 'import' | null>(null);
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
  // 分组视图（有分组且未搜索时启用）
  const groupingActive = groupsSupported && groups.length > 0 && !normalizedQuery;
  // 搜索过滤或分组视图下禁用拖拽，避免只对子集/分组排序导致全表错乱
  const canReorder = !normalizedQuery && connections.length > 1 && !groupingActive;

  // 下拉关闭时清空搜索词与拖拽态
  useEffect(() => {
    if (!isConnectionDropdownOpen) {
      setConnectionQuery('');
      setDraggedConnectionId(null);
      setDragOverConnectionId(null);
    }
  }, [isConnectionDropdownOpen]);

  // 打开下拉时刷新分组列表
  useEffect(() => {
    if (isConnectionDropdownOpen) {
      void loadGroups();
    }
  }, [isConnectionDropdownOpen, loadGroups]);

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

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleSaveGroup = async () => {
    const name = groupModal.name.trim();
    if (!name) {
      return;
    }
    const group: ConnectionGroup = {
      id: groupModal.editing?.id || `grp-${Date.now()}`,
      name,
      order: groupModal.editing?.order ?? groups.length,
    };
    await saveGroup(group);
    setGroupModal({ open: false, editing: null, name: '' });
  };

  const handleConfirmDeleteGroup = async () => {
    const target = groupToDelete;
    setGroupToDelete(null);
    if (!target) {
      return;
    }
    await deleteGroup(target.id);
    // 删除分组后服务端已把组内连接移回未分组，这里刷新连接列表
    await loadConnections();
  };

  const renderConnectionRow = (connection: SSHConnection) => (
    <div
      key={connection.id}
      draggable={canReorder}
      onDragStart={(event) => handleConnectionDragStart(event, connection.id)}
      onDragOver={(event) => handleConnectionDragOver(event, connection.id)}
      onDragLeave={handleConnectionDragLeave}
      onDrop={(event) => handleConnectionDrop(event, connection.id)}
      onDragEnd={handleConnectionDragEnd}
      className={`connection-list-row group ${
        dragOverConnectionId === connection.id
          ? 'connection-list-row-active ring-1 ring-[color-mix(in_srgb,var(--accent-primary)_45%,transparent)]'
          : ''
      } ${
        draggedConnectionId === connection.id ? 'opacity-50' : ''
      } ${canReorder ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      {canReorder && (
        <span
          className="mr-1 flex h-7 w-4 shrink-0 items-center justify-center text-fg-subtle"
          title={translate('connection.dragToReorder')}
          aria-hidden
        >
          <GripVertical className="h-4 w-4" />
        </span>
      )}
      <button
        type="button"
        onClick={() => onConnect(connection.id, connection.name)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="workspace-empty-card-icon workspace-empty-card-icon-connect">
          <Server className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg dark:text-white">
            {connection.name}
          </div>
          <div className="truncate text-xs text-fg-muted">
            {connection.username}@{connection.host}:{connection.port}
          </div>
          {connection.tags && connection.tags.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {connection.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 rounded-sm border border-accent bg-accent-muted px-1 py-0.5 text-[10px] text-accent dark:text-accent-hover"
                >
                  <Tag className="h-2.5 w-2.5" />
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>
      <div className="hidden items-center gap-1 group-hover:flex">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onEditConnection(connection);
          }}
          className="icon-button h-7 w-7"
          title={translate('common.edit')}
          aria-label={translate('common.edit')}
        >
          <Edit3 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDeleteConnection(connection.id);
          }}
          className="icon-button h-7 w-7 hover:text-danger"
          title={translate('common.delete')}
          aria-label={translate('common.delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );

  const renderGroupedConnections = () => {
    const knownGroupIds = new Set(groups.map((group) => group.id));
    const sortedGroups = [...groups].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name),
    );
    const ungrouped = filteredConnections.filter(
      (connection) => !connection.groupId || !knownGroupIds.has(connection.groupId),
    );
    return (
      <>
        {sortedGroups.map((group) => {
          const members = filteredConnections.filter((connection) => connection.groupId === group.id);
          const collapsed = collapsedGroups.has(group.id);
          return (
            <div key={group.id} className="mb-0.5">
              <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-[color-mix(in_srgb,var(--accent-primary)_8%,transparent)]">
                <button
                  type="button"
                  onClick={() => toggleGroupCollapsed(group.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold text-fg-secondary"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
                  />
                  <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="truncate">{group.name}</span>
                  <span className="ml-0.5 rounded-full bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-normal leading-none text-fg-muted">
                    {members.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setGroupModal({ open: true, editing: group, name: group.name })}
                  className="icon-button h-6 w-6 opacity-0 group-hover:opacity-100"
                  title={translate('features.connectionGroups.renameGroup')}
                  aria-label={translate('features.connectionGroups.renameGroup')}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setGroupToDelete(group)}
                  className="icon-button h-6 w-6 opacity-0 group-hover:opacity-100 hover:text-danger"
                  title={translate('features.connectionGroups.deleteGroup')}
                  aria-label={translate('features.connectionGroups.deleteGroup')}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              {!collapsed && (
                <div className="ml-4 border-l border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] pl-1">
                  {members.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-fg-subtle">
                      {translate('features.connectionGroups.emptyGroup')}
                    </p>
                  ) : (
                    members.map((connection) => renderConnectionRow(connection))
                  )}
                </div>
              )}
            </div>
          );
        })}
        {ungrouped.length > 0 && (
          <div className="mb-1">
            {sortedGroups.length > 0 && (
              <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs font-semibold text-fg-muted">
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span>{translate('features.connectionGroups.ungrouped')}</span>
                <span className="ml-0.5 rounded-full bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-normal leading-none">
                  {ungrouped.length}
                </span>
              </div>
            )}
            <div className={sortedGroups.length > 0 ? 'ml-4 border-l border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] pl-1' : ''}>
              {ungrouped.map((connection) => renderConnectionRow(connection))}
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <>
    <header className="app-header">
      <div className="flex items-center gap-2">
        <div className="app-title-mark">
          <AppIcon className="h-6 w-6" />
        </div>
        <div className="mr-2 leading-tight">
          <h1 className="text-sm font-semibold tracking-tight">AI SSH Client</h1>
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
                <div className="flex items-center gap-1">
                  {groupsSupported && (
                    <button
                      onClick={() => setGroupModal({ open: true, editing: null, name: '' })}
                      className="icon-button h-7 w-7"
                      title={translate('features.connectionGroups.newGroup')}
                      aria-label={translate('features.connectionGroups.newGroup')}
                    >
                      <FolderPlus className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={onCreateConnection}
                    className="icon-button h-7 w-7"
                    title={translate('connection.newConnection')}
                    aria-label={translate('connection.newConnection')}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {groupModal.open && (
                <div className="flex items-center gap-1.5 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] px-2 py-2">
                  {groupModal.editing ? (
                    <Pencil className="h-3.5 w-3.5 shrink-0 text-accent" />
                  ) : (
                    <FolderPlus className="h-3.5 w-3.5 shrink-0 text-accent" />
                  )}
                  <input
                    type="text"
                    autoFocus
                    value={groupModal.name}
                    onChange={(event) => setGroupModal((previous) => ({ ...previous, name: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void handleSaveGroup();
                      } else if (event.key === 'Escape') {
                        setGroupModal({ open: false, editing: null, name: '' });
                      }
                    }}
                    placeholder={translate('features.connectionGroups.groupName')}
                    className="industrial-input h-7 flex-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveGroup()}
                    className="icon-button h-7 w-7 text-accent dark:text-accent-hover"
                    title={translate('common.save')}
                    aria-label={translate('common.save')}
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupModal({ open: false, editing: null, name: '' })}
                    className="icon-button h-7 w-7"
                    title={translate('common.cancel')}
                    aria-label={translate('common.cancel')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
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
                <div className="p-4 text-center text-fg-muted text-sm">
                  {translate('connection.noConnections')}
                </div>
              ) : filteredConnections.length === 0 ? (
                <div className="p-4 text-center text-fg-muted text-sm">
                  {translate('connection.noMatches')}
                </div>
              ) : (
                <>
                  {groupingActive ? (
                    renderGroupedConnections()
                  ) : (
                    <>
                      {canReorder && (
                        <div className="px-3 pb-1 text-[11px] text-fg-muted">
                          {translate('connection.dragToReorder')}
                        </div>
                      )}
                      {filteredConnections.map((connection) => renderConnectionRow(connection))}
                    </>
                  )}
                </>
              )}
              {/* 连接下拉底部：导入 / 导出 */}
              <div className="mt-1 flex gap-1 border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] p-2">
                <button
                  type="button"
                  className="industrial-button-secondary flex-1 justify-center px-2 py-1.5 text-xs"
                  onClick={() => {
                    // 先关下拉再开弹窗，避免遮挡与焦点错乱
                    if (isConnectionDropdownOpen) {
                      onToggleConnectionDropdown();
                    }
                    setImportExportMode('import');
                  }}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {translate('connection.importExport.import')}
                </button>
                <button
                  type="button"
                  className="industrial-button-secondary flex-1 justify-center px-2 py-1.5 text-xs"
                  onClick={() => {
                    if (isConnectionDropdownOpen) {
                      onToggleConnectionDropdown();
                    }
                    setImportExportMode('export');
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                  {translate('connection.importExport.export')}
                </button>
              </div>
            </div>
          )}
        </div>

        {importExportMode !== null && (
          <Suspense fallback={null}>
            <ConnectionImportExportModal
              isOpen
              mode={importExportMode}
              existingConnections={connections}
              onClose={() => setImportExportMode(null)}
              onImported={async () => {
                // 导入后刷新连接列表与 AI 供应商
                await Promise.all([loadConnections(), loadProviders()]);
              }}
            />
          </Suspense>
        )}

        {activeTabId && (
          <button
            onClick={onToggleSftpSidebar}
            className={`toolbar-button ${isSftpSidebarOpen ? 'toolbar-button-active' : ''}`}
            title={translate('fileTransfer.manage')}
            aria-label={translate('fileTransfer.manage')}
          >
            <Folder className="w-4 h-4" />
            {translate('fileTransfer.files')}
          </button>
        )}

        {activeTabId && (
          <Suspense fallback={null}>
            <QuickCommandsPanel onPasteCommand={onPasteCommand} />
            <CommandHistoryPanel
              onPasteCommand={onPasteCommand}
              activeSessionId={activeTabId}
            />
          </Suspense>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="toolbar-group">
          <button
            onClick={() => onChangeTheme('light')}
            className={`icon-button h-7 w-7 ${theme === 'light' ? 'icon-button-active' : ''}`}
            title={translate('theme.light')}
            aria-label={translate('theme.light')}
          >
            <Sun className="w-4 h-4" />
          </button>
          <button
            onClick={() => onChangeTheme('dark')}
            className={`icon-button h-7 w-7 ${theme === 'dark' ? 'icon-button-active' : ''}`}
            title={translate('theme.dark')}
            aria-label={translate('theme.dark')}
          >
            <Moon className="w-4 h-4" />
          </button>
          <button
            onClick={() => onChangeTheme('system')}
            className={`icon-button h-7 w-7 ${theme === 'system' ? 'icon-button-active' : ''}`}
            title={translate('theme.system')}
            aria-label={translate('theme.system')}
          >
            <Monitor className="w-4 h-4" />
          </button>
        </div>
        <button
          onClick={onToggleSettings}
          className={`icon-button ${isSettingsOpen ? 'icon-button-active' : ''}`}
          title={translate('settings.title')}
          aria-label={translate('settings.title')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
      <ConfirmDialog
        isOpen={groupToDelete !== null}
        title={translate('features.connectionGroups.deleteGroup')}
        message={translate('features.connectionGroups.deleteGroupConfirm')}
        onConfirm={() => void handleConfirmDeleteGroup()}
        onCancel={() => setGroupToDelete(null)}
      />
    </>
  );
}
