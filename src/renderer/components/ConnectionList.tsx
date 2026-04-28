import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Server, MonitorPlay, Square, Search, Copy, RefreshCw, Globe, Key } from 'lucide-react';
import { useConnectionStore } from '../store/useConnectionStore';
import { ConfirmDialog } from './ConfirmDialog';
import type { SSHConnection } from '../../shared/types';

interface ConnectionListProps {
  onConnect?: (connection: { id: string; name: string }) => void;
  triggerAddConnection?: boolean;
  onAddConnectionTriggered?: () => void;
}

export function ConnectionList({ onConnect, triggerAddConnection, onAddConnectionTriggered }: ConnectionListProps) {
  const { connections, activeConnectionId, connect, disconnect, loadConnections, saveConnection, deleteConnection } = useConnectionStore();
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
  });

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

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
    conn.username.toLowerCase().includes(searchTerm.toLowerCase())
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
    });
    setShowAddModal(true);
  };

  const handleSaveConnection = async () => {
    const connection: SSHConnection = {
      id: editingConnection?.id || Date.now().toString(),
      name: formData.name,
      host: formData.host,
      port: formData.port,
      username: formData.username,
      password: formData.password,
      privateKey: formData.privateKey,
      passphrase: formData.passphrase,
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

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索连接..."
            className="w-full pl-8 pr-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
          />
        </div>
      </div>

      {/* Buttons */}
      <div className="p-2 flex-shrink-0">
        <button
          onClick={handleAddConnection}
          className="flex items-center gap-2 w-full p-2 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors text-white"
        >
          <Plus className="w-4 h-4" />
          新建连接
        </button>
      </div>

      {/* Connection List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-600 scrollbar-track-transparent hover:scrollbar-thumb-slate-400 dark:hover:scrollbar-thumb-slate-500">
        {filteredConnections.length === 0 ? (
          <div className="text-center text-slate-500 dark:text-slate-400 py-8">
            <Server className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{searchTerm ? '没有找到匹配的连接' : '暂无连接'}</p>
            <p className="text-xs mt-1">点击上方"新建连接"开始</p>
          </div>
        ) : (
          filteredConnections.map(connection => (
            <div
              key={connection.id}
              onContextMenu={(e) => handleContextMenu(e, connection)}
              className={`p-2 mb-1 rounded border transition-colors ${
                activeConnectionId === connection.id
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Server className="w-3 h-3 text-slate-400 flex-shrink-0" />
                    <span className="font-medium text-sm truncate text-slate-900 dark:text-white">{connection.name}</span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate flex items-center gap-1">
                    <Globe className="w-3 h-3" />
                    {connection.username}@{connection.host}:{connection.port}
                  </p>
                  {connection.privateKey && (
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 flex items-center gap-1">
                      <Key className="w-3 h-3" />
                      密钥认证
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 mt-2">
                {activeConnectionId === connection.id ? (
                  <button
                    onClick={() => handleDisconnect(connection.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-500 rounded transition-colors"
                  >
                    <Square className="w-3 h-3" />
                    断开
                  </button>
                ) : (
                  <button
                    onClick={() => handleConnect(connection)}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-green-600 hover:bg-green-500 rounded transition-colors"
                  >
                    <MonitorPlay className="w-3 h-3" />
                    连接
                  </button>
                )}
                <button
                  onClick={() => handleEditConnection(connection)}
                  className="p-1 text-slate-400 hover:text-white rounded transition-colors"
                  title="编辑"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDeleteConnection(connection.id)}
                  className="p-1 text-slate-400 hover:text-red-500 rounded transition-colors"
                  title="删除"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleCopyConnection(contextMenu.connection)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <Copy className="w-4 h-4" />
            复制连接
          </button>
          <button
            onClick={() => handleReconnect(contextMenu.connection)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            重新连接
          </button>
          <div className="my-1 border-t border-slate-200 dark:border-slate-700" />
          <button
            onClick={() => {
              handleEditConnection(contextMenu.connection);
              closeContextMenu();
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            编辑
          </button>
          <button
            onClick={() => {
              const connId = contextMenu.connection.id;
              closeContextMenu();
              handleDeleteConnection(connId);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            删除
          </button>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4 text-slate-900 dark:text-white">
              {editingConnection ? '编辑连接' : '新建连接'}
            </h3>
            <div className="space-y-3">
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="连接名称"
                className="w-full p-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={formData.host}
                onChange={(e) => setFormData(prev => ({ ...prev, host: e.target.value }))}
                placeholder="主机地址"
                className="w-full p-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
              />
              <input
                type="number"
                value={formData.port}
                onChange={(e) => setFormData(prev => ({ ...prev, port: parseInt(e.target.value) || 22 }))}
                placeholder="端口"
                className="w-full p-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={formData.username}
                onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))}
                placeholder="用户名"
                className="w-full p-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
              />
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                placeholder="密码"
                className="w-full p-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
              />
              <div className="text-xs text-slate-500">或者使用私钥认证：</div>
              <textarea
                value={formData.privateKey}
                onChange={(e) => setFormData(prev => ({ ...prev, privateKey: e.target.value }))}
                placeholder="粘贴私钥内容..."
                rows={4}
                className="w-full p-2 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white resize-none"
              />
              <button
                onClick={handleSelectFile}
                className="text-xs text-blue-500 hover:text-blue-400"
              >
                选择私钥文件
              </button>
              {formData.privateKey && (
                <input
                  type="password"
                  value={formData.passphrase}
                  onChange={(e) => setFormData(prev => ({ ...prev, passphrase: e.target.value }))}
                  placeholder="私钥密码（可选）"
                  className="w-full p-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                />
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 p-2 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition-colors text-slate-700 dark:text-slate-300"
              >
                取消
              </button>
              <button
                onClick={handleSaveConnection}
                className="flex-1 p-2 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors text-white"
              >
                保存
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
