import { useEffect, useState, useRef, useCallback } from 'react';
import {
  X,
  Wifi,
  WifiOff,
  Loader2,
  Copy,
  RefreshCw,
  Edit3,
  MoreVertical,
  ChevronRight,
} from 'lucide-react';
import { AssistantHost } from '../assistant/AssistantHost';
import { useConnectionStore } from '../store/useConnectionStore';
import { useAIStore } from '../store/useAIStore';
import { useAgentStore } from '../store/useAgentStore';
import { useTheme } from '../hooks/useTheme';
import { useI18n } from '../i18n';
import type { CommandSuggestion, SSHSessionState, SSHConnection, Session } from '../../shared/types';
import type { AppSettings } from '../../shared/types';
import { useSessionBridge } from '../session/useSessionBridge';
import { useSessionRecovery } from '../session/useSessionRecovery';
import { useSessionStore } from '../session/useSessionStore';
import { AppFooter } from './AppFooter';
import { AppShell } from './AppShell';
import { ModalHost } from './ModalHost';
import { ToastHost, type AppToast } from './ToastHost';
import { WorkspaceHeader } from './WorkspaceHeader';
import { SessionWorkspace } from '../workspace/SessionWorkspace';
import { WorkspaceTabs } from '../workspace/WorkspaceTabs';
import { useWorkspaceStore } from '../workspace/useWorkspaceStore';

// Tab 类型
interface Tab {
  id: string;
  name: string;
  isConnected: boolean;
  isConnecting: boolean;
  lastError?: string;
  restoredFromScrollback?: boolean;
  state?: Session['state'];
}

function areTabsEqual(left: Tab[], right: Tab[]): boolean {
  return left.length === right.length
    && left.every((tab, index) => {
      const next = right[index];
      return next
        && tab.id === next.id
        && tab.name === next.name
        && tab.isConnected === next.isConnected
        && tab.isConnecting === next.isConnecting
        && tab.state === next.state
        && tab.restoredFromScrollback === next.restoredFromScrollback
        && tab.lastError === next.lastError;
    });
}

// 拖拽状态
interface DragState {
  isDragging: boolean;
  draggedTabId: string | null;
  dragOverTabId: string | null;
}

export function AppController() {
  const { t } = useI18n();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'terminal' | 'ssh' | 'providers' | 'security' | 'agent'>('terminal');
  const [showAgentPet, setShowAgentPet] = useState(false);
  const [agentInput, setAgentInput] = useState('');
  const [agentInputFocusToken, setAgentInputFocusToken] = useState(0);
  const [pendingCommand, setPendingCommand] = useState<CommandSuggestion | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showConnectionDropdown, setShowConnectionDropdown] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SSHConnection | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [toasts, setToasts] = useState<AppToast[]>([]);

  const commandStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const intentionalDisconnectsRef = useRef<Set<string>>(new Set());

  // Tab右键菜单
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string; tabName: string } | null>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const connectionDropdownRef = useRef<HTMLDivElement>(null);

  // 拖拽状态
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    draggedTabId: null,
    dragOverTabId: null,
  });

  const { theme, changeTheme, settings, updateSettings } = useTheme();
  const {
    connections,
    loadConnections,
    connect,
    reconnect,
    disconnect,
    deleteConnection,
  } = useConnectionStore();
  const { loadProviders } = useAIStore();
  const registerSession = useSessionStore((state) => state.registerSession);
  const removeSession = useSessionStore((state) => state.removeSession);
  const sessionRecords = useSessionStore((state) => state.sessions);
  const sessionIds = useSessionStore((state) => state.orderedSessionIds);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const setSessionState = useSessionStore((state) => state.setSessionState);
  const markIntentionalDisconnect = useSessionStore((state) => state.markIntentionalDisconnect);
  const isSftpSidebarOpen = useWorkspaceStore((state) => state.isSftpSidebarOpen);
  const setSftpSidebarOpen = useWorkspaceStore((state) => state.setSftpSidebarOpen);
  const toggleSftpSidebar = useWorkspaceStore((state) => state.toggleSftpSidebar);

  useSessionRecovery(connections);

  // 打开的标签页
  const [openTabs, setOpenTabs] = useState<Tab[]>([]);

  // 命令执行状态
  const [commandStatus, setCommandStatus] = useState<{ command: string; status: 'pending' | 'success' | 'error'; timestamp: number } | null>(null);

  useEffect(() => {
    useAgentStore.getState().syncFromSettings(settings);
  }, [settings]);

  const updateTabState = (connectionId: string, state: SSHSessionState) => {
    setOpenTabs(prev => prev.map(tab =>
      tab.id === connectionId
        ? { ...tab, isConnected: state.isConnected, isConnecting: state.isConnecting }
        : tab
    ));
  };

  const handleConnectionClose = (connectionId: string) => {
    setOpenTabs(prev => prev.map(tab =>
      tab.id === connectionId
        ? { ...tab, isConnected: false, isConnecting: false }
        : tab
    ));
  };

  const markSessionConnectResult = (
    sessionId: string,
    success: boolean,
    lastError?: string,
  ) => {
    setSessionState(sessionId, success
      ? {
          state: 'connected',
          reconnectAttempts: 0,
          lastActiveAt: Date.now(),
          lastError: undefined,
          restoredFromScrollback: false,
        }
      : {
          state: 'error',
          reconnectAttempts: 0,
          lastActiveAt: Date.now(),
          lastError,
          restoredFromScrollback: false,
        });
  };

  const handleTabClick = (tabId: string) => {
    setActiveTabId(tabId);
    setActiveSession(tabId);
  };

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const { disconnect } = useConnectionStore.getState();
    markIntentionalDisconnect(tabId);
    intentionalDisconnectsRef.current.add(tabId);
    await disconnect(tabId);
    removeSession(tabId);
    setOpenTabs(prev => prev.filter(tab => tab.id !== tabId));
    if (activeTabId === tabId) {
      const remainingTabs = openTabs.filter(tab => tab.id !== tabId);
      if (remainingTabs.length > 0) {
        setActiveTabId(remainingTabs[0].id);
        setActiveSession(remainingTabs[0].id);
      } else {
        setActiveTabId(null);
        setActiveSession(null);
      }
    }
  };

  const handleConnect = async (connectionId: string, connectionName: string) => {
    const { connections, connect } = useConnectionStore.getState();
    const fullConnection = connections.find(c => c.id === connectionId);

    if (!fullConnection) {
      return;
    }

    // 检查是否已打开该连接
    const existingTab = openTabs.find(tab => tab.id === connectionId);
    if (existingTab) {
      setActiveTabId(connectionId);
      setActiveSession(connectionId);
      return;
    }

    // 添加新标签页（初始状态为连接中）
    const newTab = { id: connectionId, name: connectionName || fullConnection.name, isConnected: false, isConnecting: true };
    setOpenTabs(prev => [...prev, newTab]);
    setActiveTabId(connectionId);
    registerSession(fullConnection, { state: 'connecting', lastActiveAt: Date.now() });
    setActiveSession(connectionId);

    // 执行连接并检查返回值（初始 PTY 尺寸会被 Terminal 组件的 fit() 立即覆盖）
    const success = await connect(fullConnection, 200, 50, settings);
    markSessionConnectResult(connectionId, success);

    // 根据连接结果更新标签页状态
    setOpenTabs(prev => prev.map(tab =>
      tab.id === connectionId
        ? { ...tab, isConnecting: false, isConnected: success }
        : tab
    ));
  };

  const handleReconnect = async (tabId: string) => {
    setSessionState(tabId, {
      state: 'reconnecting',
      lastActiveAt: Date.now(),
    });
    setOpenTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, isConnecting: true } : tab
    ));
    const result = await reconnect(tabId);
    markSessionConnectResult(tabId, result);
    if (!result) {
      setOpenTabs(prev => prev.map(tab =>
        tab.id === tabId ? { ...tab, isConnecting: false, isConnected: false } : tab
      ));
    }
  };

  const handleApproveCommand = async () => {
    if (pendingCommand) {
      // 先缓存命令，避免闭包问题
      const command = pendingCommand.command;
      const connectionId = useSessionStore.getState().activeSessionId;
      setCommandStatus({ command, status: 'pending', timestamp: Date.now() });
      const result = connectionId && window.electronAPI
        ? await window.electronAPI.sshExecute(connectionId, `${command}\n`)
        : undefined;
      setPendingCommand(null);

      if (!result?.success) {
        setCommandStatus({ command, status: 'error', timestamp: Date.now() });
        if (commandStatusTimeoutRef.current) {
          clearTimeout(commandStatusTimeoutRef.current);
        }
        commandStatusTimeoutRef.current = setTimeout(() => setCommandStatus(null), 3000);
        return;
      }

      setCommandStatus(prev => prev?.command === command ? { ...prev, status: 'success' } : prev);
      if (commandStatusTimeoutRef.current) {
        clearTimeout(commandStatusTimeoutRef.current);
      }
      commandStatusTimeoutRef.current = setTimeout(() => setCommandStatus(null), 2000);
    }
  };

  const handlePasteToAI = useCallback((text: string) => {
    const cleanText = text.replace(/[\r\n]+$/, '');
    if (!cleanText) {
      return;
    }

    setShowAgentPet(true);
    setAgentInput((prev) => prev ? `${prev}\n${cleanText}` : cleanText);
    setAgentInputFocusToken((prev) => prev + 1);
  }, []);

  const handleRejectCommand = () => {
    setPendingCommand(null);
  };

  const dismissToast = useCallback((toastId: string) => {
    const timer = toastTimersRef.current.get(toastId);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(toastId);
    }
    setToasts(prev => prev.filter(toast => toast.id !== toastId));
  }, []);

  const showToast = useCallback((toast: Omit<AppToast, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts(prev => [...prev.slice(-2), { ...toast, id }]);
    const timer = setTimeout(() => dismissToast(id), 5000);
    toastTimersRef.current.set(id, timer);
  }, [dismissToast]);

  useSessionBridge({
    connections,
    settings,
    onTransferToast: showToast,
    onSessionStateChange: updateTabState,
    onSessionClosed: (connectionId) => {
      handleConnectionClose(connectionId);
    },
    translate: t,
  });

  useEffect(() => {
    const toTab = (sessionId: string): Tab | null => {
      const session = sessionRecords[sessionId];
      if (!session) {
        return null;
      }

      return {
        id: session.id,
        name: session.title,
        isConnected: session.state === 'connected',
        isConnecting: session.state === 'connecting' || session.state === 'reconnecting',
        lastError: session.lastError,
        restoredFromScrollback: session.restoredFromScrollback,
        state: session.state,
      };
    };

    setOpenTabs((previousTabs) => {
      const nextTabs = previousTabs
        .map((tab) => toTab(tab.id))
        .filter((tab): tab is Tab => Boolean(tab));

      sessionIds.forEach((sessionId) => {
        if (nextTabs.some((tab) => tab.id === sessionId)) {
          return;
        }

        const nextTab = toTab(sessionId);
        if (nextTab) {
          nextTabs.push(nextTab);
        }
      });

      return areTabsEqual(previousTabs, nextTabs) ? previousTabs : nextTabs;
    });

    if (!activeTabId && sessionIds.length > 0) {
      setActiveTabId(sessionIds[0]);
      if (useSessionStore.getState().activeSessionId !== sessionIds[0]) {
        setActiveSession(sessionIds[0]);
      }
    }
  }, [activeTabId, sessionIds, sessionRecords, setActiveSession]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    loadConnections();
    loadProviders();
    void window.electronAPI.getAgentTaskHistory?.().then((result) => {
      if (!result?.success) return;
      useAgentStore.getState().setTaskHistory(result.data.tasks);
    });

    return () => {
      if (commandStatusTimeoutRef.current != null) {
        clearTimeout(commandStatusTimeoutRef.current);
        commandStatusTimeoutRef.current = null;
      }
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, [
    loadConnections,
    loadProviders,
  ]);

  const getConnectionStatus = () => {
    const currentTab = openTabs.find(tab => tab.id === activeTabId);
    if (!currentTab) return { icon: <WifiOff className="w-3 h-3" />, text: t('connection.status.disconnected'), color: 'text-slate-500' };
    if (currentTab.restoredFromScrollback) return { icon: <WifiOff className="w-3 h-3" />, text: t('connection.status.restored'), color: 'text-slate-500' };
    if (currentTab.state === 'reconnecting') return { icon: <Loader2 className="w-3 h-3 animate-spin" />, text: t('connection.status.reconnecting'), color: 'text-yellow-500' };
    if (currentTab.isConnecting) return { icon: <Loader2 className="w-3 h-3 animate-spin" />, text: t('connection.status.connecting'), color: 'text-yellow-500' };
    if (currentTab.isConnected) return { icon: <Wifi className="w-3 h-3" />, text: t('connection.status.connected'), color: 'text-green-500' };
    if (currentTab.state === 'error') return { icon: <WifiOff className="w-3 h-3" />, text: t('connection.status.error'), color: 'text-red-500' };
    return { icon: <WifiOff className="w-3 h-3" />, text: t('connection.status.closed'), color: 'text-red-500' };
  };

  const status = getConnectionStatus();

  // Tab右键菜单处理
  const handleTabContextMenu = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    setTabContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id, tabName: tab.name });
  };

  // 复制连接（临时会话，不保存到连接列表）
  const handleCopyConnection = async () => {
    if (!tabContextMenu) return;
    const { tabId } = tabContextMenu;
    const conns = useConnectionStore.getState().connections;
    const connection = conns.find(c => c.id === tabId);
    if (connection && window.electronAPI) {
      const newConnectionId = `${connection.id}-session-${Date.now()}`;
      const newConnection: SSHConnection = {
        ...connection,
        id: newConnectionId,
        name: `${connection.name} ${t('connection.copySuffix')}`,
      };
      // 不保存到连接列表，直接建立 SSH 连接
      const newTab = { id: newConnectionId, name: newConnection.name, isConnected: false, isConnecting: true };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabId(newConnectionId);
      registerSession(newConnection, { state: 'connecting', lastActiveAt: Date.now() });
      setActiveSession(newConnectionId);

      const result = await window.electronAPI.sshConnect(newConnection, 200, 50, settings);
      markSessionConnectResult(newConnectionId, result.success, result.success ? undefined : result.error);
      setOpenTabs(prev => prev.map(tab =>
        tab.id === newConnectionId
          ? { ...tab, isConnecting: false, isConnected: result.success }
          : tab
      ));
    }
    setTabContextMenu(null);
  };

  // 重新连接
  const handleReconnectTab = async () => {
    if (!tabContextMenu) return;
    const { tabId } = tabContextMenu;
    await handleReconnect(tabId);
    setTabContextMenu(null);
  };

  // 关闭当前标签页
  const handleCloseCurrentTab = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabContextMenu) {
      handleCloseTab(e, tabContextMenu.tabId);
    }
    setTabContextMenu(null);
  };

  // 关闭其他标签页
  const handleCloseOtherTabs = async () => {
    if (!tabContextMenu) return;
    const { tabId } = tabContextMenu;
    const tabsToClose = openTabs.filter(tab => tab.id !== tabId);
    tabsToClose.forEach(tab => {
      markIntentionalDisconnect(tab.id);
      intentionalDisconnectsRef.current.add(tab.id);
    });
    // 等待所有断开连接完成
    await Promise.all(tabsToClose.map(tab => disconnect(tab.id)));
    tabsToClose.forEach((tab) => removeSession(tab.id));
    setOpenTabs([openTabs.find(tab => tab.id === tabId)!]);
    setActiveTabId(tabId);
    setActiveSession(tabId);
    setTabContextMenu(null);
  };

  // 关闭所有标签页
  const handleCloseAllTabs = async () => {
    openTabs.forEach(tab => {
      markIntentionalDisconnect(tab.id);
      intentionalDisconnectsRef.current.add(tab.id);
    });
    // 等待所有断开连接完成
    await Promise.all(openTabs.map(tab => disconnect(tab.id)));
    openTabs.forEach((tab) => removeSession(tab.id));
    setOpenTabs([]);
    setActiveTabId(null);
    setActiveSession(null);
    setTabContextMenu(null);
  };

  // 编辑连接
  const handleEditConnection = () => {
    if (!tabContextMenu) return;
    const { tabId } = tabContextMenu;
    const connection = connections.find(c => c.id === tabId);
    if (connection) {
      setEditingConnection(connection);
    }
    setTabContextMenu(null);
  };

  // 删除连接
  const handleDeleteConnection = async () => {
    if (!deletingConnection) return;
    await deleteConnection(deletingConnection);
    // 如果该连接有打开的标签页，也关闭它
    const existingTab = openTabs.find(tab => tab.id === deletingConnection);
    if (existingTab) {
      markIntentionalDisconnect(deletingConnection);
      intentionalDisconnectsRef.current.add(deletingConnection);
      await disconnect(deletingConnection);
      removeSession(deletingConnection);
      setOpenTabs(prev => prev.filter(tab => tab.id !== deletingConnection));
    }
    setDeletingConnection(null);
  };

  // 拖拽相关
  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    setDragState({ isDragging: true, draggedTabId: tabId, dragOverTabId: null });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
  };

  const handleDragOver = (e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    if (dragState.draggedTabId && dragState.draggedTabId !== tabId) {
      setDragState(prev => ({ ...prev, dragOverTabId: tabId }));
    }
  };

  const handleDragLeave = () => {
    setDragState(prev => ({ ...prev, dragOverTabId: null }));
  };

  const handleDrop = (e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    const draggedTabId = e.dataTransfer.getData('text/plain');

    if (draggedTabId && draggedTabId !== targetTabId) {
      setOpenTabs(prev => {
        const tabs = [...prev];
        const draggedIndex = tabs.findIndex(t => t.id === draggedTabId);
        const targetIndex = tabs.findIndex(t => t.id === targetTabId);

        if (draggedIndex !== -1 && targetIndex !== -1) {
          const [draggedTab] = tabs.splice(draggedIndex, 1);
          tabs.splice(targetIndex, 0, draggedTab);
        }
        return tabs;
      });
    }

    setDragState({ isDragging: false, draggedTabId: null, dragOverTabId: null });
  };

  const handleDragEnd = () => {
    setDragState({ isDragging: false, draggedTabId: null, dragOverTabId: null });
  };

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (tabContextMenuRef.current && !tabContextMenuRef.current.contains(e.target as Node)) {
        setTabContextMenu(null);
      }
      if (connectionDropdownRef.current && !connectionDropdownRef.current.contains(e.target as Node)) {
        setShowConnectionDropdown(false);
      }
    };
    if (tabContextMenu || showConnectionDropdown) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [tabContextMenu, showConnectionDropdown]);

  // 测试连接
  const handleTestConnection = async () => {
    if (!editingConnection?.host || !editingConnection?.username) {
      setConnectionTestResult({ success: false, message: t('connection.fillHostAndUser') });
      return;
    }

    setTestingConnection(true);
    setConnectionTestResult(null);

    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.sshTestConnection(editingConnection);
        if (result.success) {
          setConnectionTestResult({ success: true, message: t('connection.testSuccess') });
        } else {
          setConnectionTestResult({ success: false, message: result.error || t('connection.testFailed') });
        }
      }
    } catch (error) {
      setConnectionTestResult({ success: false, message: (error as Error).message });
    } finally {
      setTestingConnection(false);
    }
  };

  // 粘贴命令到终端
  const handlePasteCommand = useCallback((command: string) => {
    if ((window as any).writeToTerminal) {
      (window as any).writeToTerminal(command);
    }
  }, []);

  // 保存设置
  const handleSaveSettings = async (newSettings: AppSettings) => {
    updateSettings(newSettings);
    if (window.electronAPI) {
      await window.electronAPI.saveSettings(newSettings);
    }

    // 同步更新智能体配置
    useAgentStore.getState().syncFromSettings(newSettings);
  };

  const handleSaveConnection = async () => {
    if (!editingConnection?.name || !editingConnection?.host || !editingConnection?.username) {
      return;
    }

    const connectionToSave = {
      ...editingConnection,
      id: editingConnection.id || Date.now().toString(),
    };
    await useConnectionStore.getState().saveConnection(connectionToSave);
    setEditingConnection(null);
    setConnectionTestResult(null);
  };

  const handleCreateConnection = () => {
    setEditingConnection({ id: '', name: '', host: '', port: 22, username: '' });
    setShowConnectionDropdown(false);
  };

  return (
    <AppShell
      header={(
        <WorkspaceHeader
        activeTabId={activeTabId}
        connections={connections}
        connectionDropdownRef={connectionDropdownRef}
        isConnectionDropdownOpen={showConnectionDropdown}
        isSettingsOpen={showSettings}
        isSftpSidebarOpen={isSftpSidebarOpen}
        theme={theme}
        translate={t}
        onChangeTheme={changeTheme}
        onConnect={(connectionId, connectionName) => {
          void handleConnect(connectionId, connectionName);
          setShowConnectionDropdown(false);
        }}
        onCreateConnection={handleCreateConnection}
        onDeleteConnection={(connectionId) => {
          setDeletingConnection(connectionId);
          setShowConnectionDropdown(false);
        }}
        onEditConnection={(connection) => {
          setEditingConnection(connection);
          setShowConnectionDropdown(false);
        }}
        onPasteCommand={handlePasteCommand}
        onToggleConnectionDropdown={() => setShowConnectionDropdown((isOpen) => !isOpen)}
        onToggleSettings={() => {
          setSettingsInitialTab('terminal');
          setShowSettings((isOpen) => !isOpen);
        }}
        onToggleSftpSidebar={toggleSftpSidebar}
      />
      )}
      tabs={(
        <>
          <WorkspaceTabs
        tabs={openTabs}
        activeTabId={activeTabId}
        dragState={dragState}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
        onTabClick={handleTabClick}
        onTabContextMenu={handleTabContextMenu}
        onCloseTab={handleCloseTab}
      />

          {tabContextMenu && (
            <div
              ref={tabContextMenuRef}
              className="app-popover fixed top-auto mt-0 py-1 min-w-[160px]"
              style={{
                left: Math.max(8, Math.min(tabContextMenu.x, window.innerWidth - 188)),
                top: Math.max(8, Math.min(tabContextMenu.y, window.innerHeight - 268)),
              }}
            >
              <button
                onClick={handleCopyConnection}
                className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
              >
                <Copy className="w-4 h-4" />
                {t('connection.copyConnection')}
              </button>
              <button
                onClick={handleEditConnection}
                className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
              >
                <Edit3 className="w-4 h-4" />
                {t('connection.editConnection')}
              </button>
              <button
                onClick={handleReconnectTab}
                className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
              >
                <RefreshCw className="w-4 h-4" />
                {t('connection.reconnect')}
              </button>
              <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
              <button
                onClick={handleCloseCurrentTab}
                className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
              >
                <X className="w-4 h-4" />
                {t('tab.closeTab')}
              </button>
              <button
                onClick={handleCloseOtherTabs}
                className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
              >
                <ChevronRight className="w-4 h-4" />
                {t('tab.closeOtherTabs')}
              </button>
              <button
                onClick={handleCloseAllTabs}
                className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
              >
                <MoreVertical className="w-4 h-4" />
                {t('tab.closeAllTabs')}
              </button>
            </div>
          )}
        </>
      )}
      workspace={(
        <SessionWorkspace
        activeTabId={activeTabId}
        tabs={openTabs}
        isSftpSidebarOpen={isSftpSidebarOpen}
        onPasteToAI={handlePasteToAI}
        onCloseSftpSidebar={() => setSftpSidebarOpen(false)}
        theme={theme}
        settings={settings}
      />
      )}
      assistant={(
        <AssistantHost
        input={agentInput}
        onInputChange={setAgentInput}
        focusInputToken={agentInputFocusToken}
        isOpen={showAgentPet}
        onOpenChange={setShowAgentPet}
        onOpenSettings={() => {
          setSettingsInitialTab('providers');
          setShowSettings(true);
        }}
      />
      )}
      toasts={<ToastHost toasts={toasts} onDismiss={dismissToast} translate={t} />}
      footer={<AppFooter status={status} commandStatus={commandStatus} translate={t} />}
      modals={(
        <ModalHost
        connectionTestResult={connectionTestResult}
        deletingConnection={deletingConnection}
        editingConnection={editingConnection}
        isSettingsOpen={showSettings}
        pendingCommand={pendingCommand}
        settings={settings}
        settingsInitialTab={settingsInitialTab}
        testingConnection={testingConnection}
        translate={t}
        onApproveCommand={handleApproveCommand}
        onChangeEditingConnection={setEditingConnection}
        onCloseSettings={() => setShowSettings(false)}
        onDeleteConnection={handleDeleteConnection}
        onRejectCommand={handleRejectCommand}
        onSaveConnection={handleSaveConnection}
        onSaveSettings={handleSaveSettings}
        onSetConnectionTestResult={setConnectionTestResult}
        onSetDeletingConnection={setDeletingConnection}
        onTestConnection={handleTestConnection}
      />
      )}
    />
  );
}

