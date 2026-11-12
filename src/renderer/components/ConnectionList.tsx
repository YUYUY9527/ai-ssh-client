import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Server, MonitorPlay, Square, Search, Copy, RefreshCw, Globe, Key, X, Folder, FolderPlus, ChevronDown, ChevronRight, Tag, Pencil } from 'lucide-react';
import { useConnectionStore } from '../store/useConnectionStore';
import { useConnectionGroupStore } from '../store/useConnectionGroupStore';
import { useSessionStore } from '../session/useSessionStore';
import { ConfirmDialog } from './ConfirmDialog';
import { useI18n } from '../i18n';
import type { SSHConnection, ConnectionGroup } from '../../shared/types';

interface ConnectionListProps {
  onConnect?: (connection: { id: string; name: string }) => void;
  triggerAddConnection?: boolean;
  onAddConnectionTriggered?: () => void;
}

export function ConnectionList({ onConnect, triggerAddConnection, onAddConnectionTriggered }: ConnectionListProps) {
  const { t } = useI18n();
  const { connections, connect, disconnect, loadConnections, saveConnection, deleteConnection } = useConnectionStore();
  const { groups, supported: groupsSupported, loadGroups, saveGroup, deleteGroup } = useConnectionGroupStore();
  const activeConnectionId = useSessionStore((state) => state.activeSessionId);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SSHConnection | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  // 确认弹窗
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', onConfirm: () => {} });
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connection: SSHConnection } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [formData, setFormData] = useState({
    name: '',
    host: '',
    port: 22,
    username: '',
    password: '',
    privateKey: '',
    passphrase: '',
    groupId: '',
    tags: '',
  });
  // 分组管理
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupModal, setGroupModal] = useState<{ open: boolean; editing: ConnectionGroup | null; name: string }>({
    open: false, editing: null, name: '',
  });

  useEffect(() => {
    loadConnections();
    loadGroups();
  }, [loadConnections, loadGroups]);

  // 处理外部触发的新建连接
  useEffect(() => {
    if (triggerAddConnection && onAddConnectionTriggered) {
      handleAddConnection();
      onAddConnectionTriggered();
    }
  }, [triggerAddConnection]);

  const filteredConnections = connections.filter(conn =>
    conn.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    conn.host.toLowerCase().includes(searchTerm.toLowerCase()) ||
    conn.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (conn.tags || []).some(tag => tag.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const handleAddConnection = () => {
    setEditingConnection(null);
    setFormData({
      name: '',
      host: '',
      port: 22,
      username: '',
      password: '',
      privateKey: '',
      passphrase: '',
      groupId: '',
      tags: '',
    });
    setShowAddModal(true);
  };

  const handleEditConnection = (connection: SSHConnection) => {
    setEditingConnection(connection);
    setFormData({
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password || '',
      privateKey: connection.privateKey || '',
      passphrase: connection.passphrase || '',
      groupId: connection.groupId || '',
      tags: (connection.tags || []).join(', '),
    });
    setShowAddModal(true);
  };

  const handleSaveConnection = async () => {
    const tags = formData.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
    const connection: SSHConnection = {
      id: editingConnection?.id || Date.now().toString(),
      name: formData.name,
      host: formData.host,
      port: formData.port,
      username: formData.username,
      password: formData.password,
      privateKey: formData.privateKey,
      passphrase: formData.passphrase,
      groupId: formData.groupId || undefined,
      tags: tags.length > 0 ? tags : undefined,
    };
    await saveConnection(connection);
    setShowAddModal(false);
  };

  const handleConnect = async (connection: SSHConnection) => {
    if (onConnect) {
      onConnect({ id: connection.id, name: connection.name });
    }
    await connect(connection);
  };

  const handleDisconnect = async (connectionId: string) => {
    await disconnect(connectionId);
  };

  const handleDeleteConnection = async (connectionId: string) => {
    setConfirmDialog({
      open: true,
      title: '删除连接',
      message: '确定要删除这个连接吗？',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, open: false }));
        await deleteConnection(connectionId);
      },
    });
  };

  const handleSelectFile = async () => {
    const result = await window.electronAPI.selectFile({
      title: '选择私钥文件',
      filters: [
        { name: 'PEM Files', extensions: ['pem', 'key', 'ppk'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.success && result.data?.filePath) {
      const contentResult = await window.electronAPI.readPrivateKeyFile(result.data.filePath);
      if (contentResult.success && contentResult.data?.content) {
        setFormData(prev => ({ ...prev, privateKey: contentResult.data.content }));
      }
    }
  };

  // 右键菜单处理
  const handleContextMenu = (e: React.MouseEvent, connection: SSHConnection) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, connection });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const handleCopyConnection = (connection: SSHConnection) => {
    const connectionString = `${connection.username}@${connection.host}:${connection.port}`;
    navigator.clipboard.writeText(connectionString).then(() => {});
    closeContextMenu();
  };

  const handleReconnect = async (connection: SSHConnection) => {
    if (activeConnectionId === connection.id) {
      await disconnect(connection.id);
    }
    await handleConnect(connection);
    closeContextMenu();
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu]);

  // ---- 分组管理 ----
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const handleSaveGroup = async () => {
    const name = groupModal.name.trim();
    if (!name) return;
    const group: ConnectionGroup = {
      id: groupModal.editing?.id || `grp-${Date.now()}`,
      name,
      order: groupModal.editing?.order ?? groups.length,
    };
    await saveGroup(group);
    setGroupModal({ open: false, editing: null, name: '' });
  };

  const handleDeleteGroup = (group: ConnectionGroup) => {
    setConfirmDialog({
      open: true,
      title: t('features.connectionGroups.deleteGroup'),
      message: t('features.connectionGroups.deleteGroupConfirm'),
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, open: false }));
        await deleteGroup(group.id);
        // 删除分组后刷新连接（服务端已把组内连接移回未分组）
        await loadConnections();
      },
    });
  };

  const renderConnectionCard = (connection: SSHConnection) => (
    <div
      key={connection.id}
      onContextMenu={(e) => handleContextMenu(e, connection)}
      className={`p-2 mb-1 rounded-sm border transition-colors ${
        activeConnectionId === connection.id
          ? 'connection-list-row-active'
          : 'border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_68%,var(--bg-secondary))] hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Server className="w-3 h-3 text-fg-subtle flex-shrink-0" />
            <span className="font-medium text-sm truncate text-fg dark:text-white">{connection.name}</span>
          </div>
          <p className="text-xs text-fg-muted mt-1 truncate flex items-center gap-1">
            <Globe className="w-3 h-3" />
            {connection.username}@{connection.host}:{connection.port}
          </p>
          {connection.privateKey && (
            <p className="text-xs text-fg-subtle mt-0.5 flex items-center gap-1">
              <Key className="w-3 h-3" />
              密钥认证
            </p>
          )}
          {connection.tags && connection.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {connection.tags.map(tag => (
                <span key={tag} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm text-[10px] bg-accent-muted text-accent dark:text-accent-hover border border-accent">
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 mt-2">
        {activeConnectionId === connection.id ? (
          <button
            onClick={() => handleDisconnect(connection.id)}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-danger hover:bg-danger rounded-sm transition-colors text-white"
          >
            <Square className="w-3 h-3" />
            断开
          </button>
        ) : (
          <button
            onClick={() => handleConnect(connection)}
            className="industrial-button-primary px-2 py-1 text-xs"
          >
            <MonitorPlay className="w-3 h-3" />
            连接
          </button>
        )}
        <button
          onClick={() => handleEditConnection(connection)}
          className="icon-button h-6 w-6"
          title="编辑"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button
          onClick={() => handleDeleteConnection(connection.id)}
          className="icon-button h-6 w-6 hover:text-danger"
          title="删除"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );

  const renderGrouped = () => {
    const knownGroupIds = new Set(groups.map(g => g.id));
    const sortedGroups = [...groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
    const ungrouped = filteredConnections.filter(c => !c.groupId || !knownGroupIds.has(c.groupId));
    return (
      <>
        {sortedGroups.map(group => {
          const members = filteredConnections.filter(c => c.groupId === group.id);
          const collapsed = collapsedGroups.has(group.id);
          return (
            <div key={group.id} className="mb-2">
              <div className="flex items-center gap-1 px-1 py-1 group">
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex items-center gap-1 flex-1 min-w-0 text-left text-xs font-semibold text-fg-secondary hover:text-fg dark:hover:text-white"
                >
                  {collapsed ? <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />}
                  <Folder className="w-3.5 h-3.5 flex-shrink-0 text-accent" />
                  <span className="truncate">{group.name}</span>
                  <span className="text-fg-subtle font-normal">({members.length})</span>
                </button>
                <button
                  onClick={() => setGroupModal({ open: true, editing: group, name: group.name })}
                  className="icon-button h-5 w-5 opacity-0 group-hover:opacity-100"
                  title={t('features.connectionGroups.renameGroup')}
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  onClick={() => handleDeleteGroup(group)}
                  className="icon-button h-5 w-5 opacity-0 group-hover:opacity-100 hover:text-danger"
                  title={t('features.connectionGroups.deleteGroup')}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              {!collapsed && (
                <div className="pl-2">
                  {members.length === 0 ? (
                    <p className="text-xs text-fg-subtle px-2 py-1">{t('features.connectionGroups.emptyGroup')}</p>
                  ) : (
                    members.map(renderConnectionCard)
                  )}
                </div>
              )}
            </div>
          );
        })}
        {ungrouped.length > 0 && (
          <div className="mb-2">
            {sortedGroups.length > 0 && (
              <div className="flex items-center gap-1 px-1 py-1 text-xs font-semibold text-fg-muted">
                <Folder className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t('features.connectionGroups.ungrouped')}</span>
                <span className="font-normal">({ungrouped.length})</span>
              </div>
            )}
            <div className={sortedGroups.length > 0 ? 'pl-2' : ''}>
              {ungrouped.map(renderConnectionCard)}
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-2 border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] flex-shrink-0">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索连接..."
            className="industrial-input w-full py-1.5 pl-8 pr-2"
          />
        </div>
      </div>

      {/* Buttons */}
      <div className="p-2 flex-shrink-0 flex gap-2">
        <button
          onClick={handleAddConnection}
          className="industrial-button-primary flex-1 p-2"
        >
          <Plus className="w-4 h-4" />
          新建连接
        </button>
        {groupsSupported && (
          <button
            onClick={() => setGroupModal({ open: true, editing: null, name: '' })}
            className="industrial-button-secondary p-2"
            title={t('features.connectionGroups.newGroup')}
          >
            <FolderPlus className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Connection List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
        {filteredConnections.length === 0 ? (
          <div className="text-center text-fg-muted py-8">
            <Server className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{searchTerm ? '没有找到匹配的连接' : '暂无连接'}</p>
            <p className="text-xs mt-1">点击上方"新建连接"开始</p>
          </div>
        ) : (groupsSupported && !searchTerm) ? (
          renderGrouped()
        ) : (
          filteredConnections.map(renderConnectionCard)
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="app-popover fixed top-auto mt-0 py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleCopyConnection(contextMenu.connection)}
            className="app-popover-row text-sm text-fg-secondary"
          >
            <Copy className="w-4 h-4" />
            复制连接
          </button>
          <button
            onClick={() => handleReconnect(contextMenu.connection)}
            className="app-popover-row text-sm text-fg-secondary"
          >
            <RefreshCw className="w-4 h-4" />
            重新连接
          </button>
          <div className="my-1 border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)]" />
          <button
            onClick={() => {
              handleEditConnection(contextMenu.connection);
              closeContextMenu();
            }}
            className="app-popover-row text-sm text-fg-secondary"
          >
            编辑
          </button>
          <button
            onClick={() => {
              const connId = contextMenu.connection.id;
              closeContextMenu();
              handleDeleteConnection(connId);
            }}
            className="app-popover-row text-sm text-danger dark:text-danger-fg"
          >
            <Trash2 className="w-4 h-4" />
            删除
          </button>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-dropdown p-4">
          <div className="industrial-modal w-full max-w-md">
            <div className="industrial-modal-header">
              <h3 className="text-lg font-semibold text-fg dark:text-white">
                {editingConnection ? '编辑连接' : '新建连接'}
              </h3>
              <button onClick={() => setShowAddModal(false)} className="icon-button">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3 p-6 max-h-[70vh] overflow-y-auto">
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="连接名称"
                className="industrial-input w-full"
              />
              <input
                type="text"
                value={formData.host}
                onChange={(e) => setFormData(prev => ({ ...prev, host: e.target.value }))}
                placeholder="主机地址"
                className="industrial-input w-full"
              />
              <input
                type="number"
                value={formData.port}
                onChange={(e) => setFormData(prev => ({ ...prev, port: parseInt(e.target.value) || 22 }))}
                placeholder="端口"
                className="industrial-input w-full"
              />
              <input
                type="text"
                value={formData.username}
                onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))}
                placeholder="用户名"
                className="industrial-input w-full"
              />
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                placeholder="密码"
                className="industrial-input w-full"
              />
              <div className="text-xs text-fg-muted">或者使用私钥认证：</div>
              <textarea
                value={formData.privateKey}
                onChange={(e) => setFormData(prev => ({ ...prev, privateKey: e.target.value }))}
                placeholder="粘贴私钥内容..."
                rows={4}
                className="industrial-input w-full resize-none font-mono text-xs"
              />
              <button
                onClick={handleSelectFile}
                className="text-xs font-medium text-accent hover:text-accent dark:text-accent-hover"
              >
                选择私钥文件
              </button>
              {formData.privateKey && (
                <input
                  type="password"
                  value={formData.passphrase}
                  onChange={(e) => setFormData(prev => ({ ...prev, passphrase: e.target.value }))}
                  placeholder="私钥密码（可选）"
                  className="industrial-input w-full"
                />
              )}
              {groupsSupported && (
                <>
                  <div>
                    <label className="text-xs text-fg-muted mb-1 block">{t('features.connectionGroups.group')}</label>
                    <select
                      value={formData.groupId}
                      onChange={(e) => setFormData(prev => ({ ...prev, groupId: e.target.value }))}
                      className="industrial-input w-full"
                    >
                      <option value="">{t('features.connectionGroups.noGroup')}</option>
                      {groups.map(group => (
                        <option key={group.id} value={group.id}>{group.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-fg-muted mb-1 block">{t('features.connectionGroups.tags')}</label>
                    <input
                      type="text"
                      value={formData.tags}
                      onChange={(e) => setFormData(prev => ({ ...prev, tags: e.target.value }))}
                      placeholder={t('features.connectionGroups.tagsPlaceholder')}
                      className="industrial-input w-full"
                    />
                  </div>
                </>
              )}
            </div>
            <div className="industrial-modal-footer">
              <button
                onClick={() => setShowAddModal(false)}
                className="industrial-button-secondary flex-1"
              >
                取消
              </button>
              <button
                onClick={handleSaveConnection}
                className="industrial-button-primary flex-1"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 分组新建/重命名 Modal */}
      {groupModal.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-dropdown p-4">
          <div className="industrial-modal w-full max-w-sm">
            <div className="industrial-modal-header">
              <h3 className="text-lg font-semibold text-fg dark:text-white">
                {groupModal.editing ? t('features.connectionGroups.renameGroup') : t('features.connectionGroups.newGroup')}
              </h3>
              <button onClick={() => setGroupModal({ open: false, editing: null, name: '' })} className="icon-button">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6">
              <input
                type="text"
                autoFocus
                value={groupModal.name}
                onChange={(e) => setGroupModal(prev => ({ ...prev, name: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveGroup(); }}
                placeholder={t('features.connectionGroups.groupName')}
                className="industrial-input w-full"
              />
            </div>
            <div className="industrial-modal-footer">
              <button
                onClick={() => setGroupModal({ open: false, editing: null, name: '' })}
                className="industrial-button-secondary flex-1"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSaveGroup}
                className="industrial-button-primary flex-1"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 确认对话框 */}
      <ConfirmDialog
        isOpen={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}