import { Suspense, lazy, useEffect, useState, useRef, useCallback } from 'react';
import {
  Settings,
  Server,
  Plus,
  X,
  Wifi,
  WifiOff,
  Loader2,
  Sun,
  Moon,
  Monitor,
  Copy,
  RefreshCw,
  Plug,
  Trash2,
  Edit3,
  FolderUp,
  FolderDown,
  MoreVertical,
  Upload,
  Download,
  FileText,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Zap,
  ChevronDown as ChevronDownIcon,
  Pencil,
} from 'lucide-react';
import { Terminal } from './components/Terminal';
import { AppIcon } from './components/AppIcon';
import { AgentPet } from './components/AgentPet';
import { useConnectionStore } from './store/useConnectionStore';
import { useAIStore } from './store/useAIStore';
import { useAgentStore } from './store/useAgentStore';
import { useTheme } from './hooks/useTheme';
import { useI18n } from './i18n';
import type { CommandSuggestion, SSHSessionState, SSHConnection, QuickCommand, QuickCommandGroup } from '../shared/types';
import type { AppSettings } from '../shared/types';

const CommandApproval = lazy(async () => {
  const module = await import('./components/CommandApproval');
  return { default: module.CommandApproval };
});

const SettingsPanel = lazy(async () => {
  const module = await import('./components/SettingsPanel');
  return { default: module.SettingsPanel };
});

const FileTransfer = lazy(async () => {
  const module = await import('./components/FileTransfer');
  return { default: module.FileTransfer };
});

// Tab 类型
interface Tab {
  id: string;
  name: string;
  isConnected: boolean;
  isConnecting: boolean;
}

// 拖拽状态
interface DragState {
  isDragging: boolean;
  draggedTabId: string | null;
  dragOverTabId: string | null;
}

function LazyModalFallback() {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 px-6 py-5 flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
        <Loader2 className="w-5 h-5 animate-spin" />
        {t('common.loading')}
      </div>
    </div>
  );
}

function App() {
  const { t } = useI18n();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'terminal' | 'ssh' | 'providers' | 'security' | 'notifications' | 'agent'>('terminal');
  const lastNotificationRef = useRef<string>('');
  const pendingCommandNotificationRef = useRef<{
    connectionId: string;
    command: string;
    timer: ReturnType<typeof setTimeout> | null;
    startedAt: number;
  } | null>(null);
  const [showAgentPet, setShowAgentPet] = useState(false);
  const [agentInput, setAgentInput] = useState('');
  const [agentInputFocusToken, setAgentInputFocusToken] = useState(0);
  const [showFileTransfer, setShowFileTransfer] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<CommandSuggestion | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showConnectionDropdown, setShowConnectionDropdown] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SSHConnection | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{ success: boolean; message: string } | null>(null);
  
  // 快速命令相关状态
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [quickCommandGroups, setQuickCommandGroups] = useState<QuickCommandGroup[]>([]);
  const [editingQuickCommand, setEditingQuickCommand] = useState<QuickCommand | null>(null);
  const [editingQuickGroup, setEditingQuickGroup] = useState<QuickCommandGroup | null>(null);
  const [newQuickCommand, setNewQuickCommand] = useState({ name: '', command: '', description: '', groupId: '' });
  const [newQuickGroup, setNewQuickGroup] = useState({ name: '', color: '#3B82F6' });
  const [showQuickCommandForm, setShowQuickCommandForm] = useState(false);
  const [showQuickGroupForm, setShowQuickGroupForm] = useState(false);
  const quickCommandsDropdownRef = useRef<HTMLDivElement>(null);
  const pendingSshOutputRef = useRef<Map<string, string[]>>(new Map());
  const outputFlushHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    addTerminalOutput,
    activeConnectionId,
    executeCommand,
    sessionStates,
    connect,
    reconnect,
    disconnect,
    deleteConnection,
  } = useConnectionStore();
  const { loadProviders, analyzeCommand } = useAIStore();

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

  const handleTabClick = (tabId: string) => {
    setActiveTabId(tabId);
    useConnectionStore.getState().setActiveConnection(tabId);
  };

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const { disconnect } = useConnectionStore.getState();
    await disconnect(tabId);
    setOpenTabs(prev => prev.filter(tab => tab.id !== tabId));
    if (activeTabId === tabId) {
      const remainingTabs = openTabs.filter(tab => tab.id !== tabId);
      if (remainingTabs.length > 0) {
        setActiveTabId(remainingTabs[0].id);
        useConnectionStore.getState().setActiveConnection(remainingTabs[0].id);
      } else {
        setActiveTabId(null);
        useConnectionStore.getState().setActiveConnection(null);
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
      useConnectionStore.getState().setActiveConnection(connectionId);
      return;
    }

    // 添加新标签页（初始状态为连接中）
    const newTab = { id: connectionId, name: connectionName || fullConnection.name, isConnected: false, isConnecting: true };
    setOpenTabs(prev => [...prev, newTab]);
    setActiveTabId(connectionId);

    // 执行连接并检查返回值
    const success = await connect(fullConnection, 128, 32);

    // 根据连接结果更新标签页状态
    setOpenTabs(prev => prev.map(tab =>
      tab.id === connectionId
        ? { ...tab, isConnecting: false, isConnected: success }
        : tab
    ));
  };

  const handleReconnect = async (tabId: string) => {
    setOpenTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, isConnecting: true } : tab
    ));
    const result = await reconnect(tabId);
    // reconnect store 会更新 sessionStates，UI 状态通过 onSshData 事件更新
    // 如果重连失败，reconnectingId 会被清空
  };

  const handleCommandRequest = (command: string) => {
    const analysis = analyzeCommand(command);
    setPendingCommand(analysis);
  };

  const handleApproveCommand = async () => {
    if (pendingCommand) {
      // 先缓存命令，避免闭包问题
      const command = pendingCommand.command;
      const connectionId = activeConnectionId;
      setCommandStatus({ command, status: 'pending', timestamp: Date.now() });
      const result = await executeCommand(command);
      setPendingCommand(null);

      if (!result?.success) {
        setCommandStatus({ command, status: 'error', timestamp: Date.now() });
        if (commandStatusTimeoutRef.current) {
          clearTimeout(commandStatusTimeoutRef.current);
        }
        commandStatusTimeoutRef.current = setTimeout(() => setCommandStatus(null), 3000);
        return;
      }

      if (pendingCommandNotificationRef.current?.timer) {
        clearTimeout(pendingCommandNotificationRef.current.timer);
      }

      if (connectionId) {
        pendingCommandNotificationRef.current = {
          connectionId,
          command,
          timer: null,
          startedAt: Date.now(),
        };
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

  const showCommandNotification = useCallback(async (command: string) => {
    if (!settings?.commandNotifications || !window.electronAPI) {
      return;
    }

    const notificationKey = `${command}-${Date.now()}`;
    if (lastNotificationRef.current === notificationKey) {
      return;
    }

    lastNotificationRef.current = notificationKey;
    await window.electronAPI.showSystemNotification(t('notifications.commandCompleted'), command, {
      onlyWhenAppInBackground: true,
    });
  }, [settings?.commandNotifications]);

  const scheduleCommandNotification = useCallback((connectionId: string, data: string) => {
    const pending = pendingCommandNotificationRef.current;
    if (!pending || pending.connectionId !== connectionId || !data.trim()) {
      return;
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    pending.timer = setTimeout(() => {
      void showCommandNotification(pending.command);
      pendingCommandNotificationRef.current = null;
    }, 1200);
  }, [showCommandNotification]);

  const flushPendingSshOutput = useCallback(() => {
    outputFlushHandleRef.current = null;

    const pendingEntries = Array.from(pendingSshOutputRef.current.entries());
    pendingSshOutputRef.current.clear();

    for (const [connectionId, chunks] of pendingEntries) {
      if (!chunks.length) {
        continue;
      }

      const chunk = chunks.join('');
      addTerminalOutput(connectionId, chunk);
      scheduleCommandNotification(connectionId, chunk);
    }
  }, [addTerminalOutput, scheduleCommandNotification]);

  const queueTerminalOutput = useCallback((connectionId: string, data: string) => {
    if (!data) {
      return;
    }

    const current = pendingSshOutputRef.current.get(connectionId);
    if (current) {
      current.push(data);
    } else {
      pendingSshOutputRef.current.set(connectionId, [data]);
    }

    if (outputFlushHandleRef.current == null) {
      outputFlushHandleRef.current = setTimeout(() => {
        flushPendingSshOutput();
      }, 16);
    }
  }, [flushPendingSshOutput]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    loadConnections();
    loadProviders();
    loadQuickCommands();

    const cleanupSshData = window.electronAPI.onSshData(({ connectionId, data, type, state }) => {
      if (type === 'state' && state) {
        updateTabState(connectionId, state);
        return;
      }

      if (data) {
        queueTerminalOutput(connectionId, data);
      }
    });

    const cleanupSshError = window.electronAPI.onSshError?.(({ connectionId, error }) => {
      queueTerminalOutput(connectionId, `\r\n\x1b[31mError: ${error}\x1b[0m\r\n`);
    });

    const cleanupSshClose = window.electronAPI.onSshClose?.((connectionId) => {
      handleConnectionClose(connectionId);
    });

    const cleanupSystemResume = (window.electronAPI as any).onSystemResume?.(() => {
      console.log('[App] System resumed from sleep, checking SSH connections...');
      if (resumeCheckTimeoutRef.current != null) {
        clearTimeout(resumeCheckTimeoutRef.current);
      }
      resumeCheckTimeoutRef.current = setTimeout(async () => {
        const result = await window.electronAPI?.sshGetSessions();
        if (result?.success && result.data?.sessions) {
          const activeSessions = new Set(result.data.sessions.map((s: any) => s.connectionId));
          setOpenTabs(prev => prev.map(tab => {
            if (tab.isConnected && !activeSessions.has(tab.id)) {
              return { ...tab, isConnected: false, isConnecting: false };
            }
            return tab;
          }));
        }
      }, 2000);
    });

    return () => {
      if (pendingCommandNotificationRef.current?.timer) {
        clearTimeout(pendingCommandNotificationRef.current.timer);
      }
      pendingCommandNotificationRef.current = null;
      if (outputFlushHandleRef.current != null) {
        clearTimeout(outputFlushHandleRef.current);
        outputFlushHandleRef.current = null;
      }
      if (resumeCheckTimeoutRef.current != null) {
        clearTimeout(resumeCheckTimeoutRef.current);
        resumeCheckTimeoutRef.current = null;
      }
      if (commandStatusTimeoutRef.current != null) {
        clearTimeout(commandStatusTimeoutRef.current);
        commandStatusTimeoutRef.current = null;
      }
      flushPendingSshOutput();
      cleanupSshData();
      cleanupSshError?.();
      cleanupSshClose?.();
      cleanupSystemResume?.();
    };
  }, [flushPendingSshOutput, loadConnections, loadProviders, queueTerminalOutput]);

  const getConnectionStatus = () => {
    const currentTab = openTabs.find(tab => tab.id === activeTabId);
    if (!currentTab) return { icon: <WifiOff className="w-3 h-3" />, text: t('connection.status.disconnected'), color: 'text-slate-500' };
    if (currentTab.isConnecting) return { icon: <Loader2 className="w-3 h-3 animate-spin" />, text: t('connection.status.connecting'), color: 'text-yellow-500' };
    if (currentTab.isConnected) return { icon: <Wifi className="w-3 h-3" />, text: t('connection.status.connected'), color: 'text-green-500' };
    return { icon: <WifiOff className="w-3 h-3" />, text: t('connection.status.closed'), color: 'text-red-500' };
  };

  const status = getConnectionStatus();

  // Tab右键菜单处理
  const handleTabContextMenu = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    setTabContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id, tabName: tab.name });
  };

  // 复制连接
  const handleCopyConnection = async () => {
    if (!tabContextMenu) return;
    const { tabId } = tabContextMenu;
    const connections = useConnectionStore.getState().connections;
    const connection = connections.find(c => c.id === tabId);
    if (connection) {
      const newConnectionId = `${connection.id}-copy-${Date.now()}`;
      const newConnection: SSHConnection = {
        ...connection,
        id: newConnectionId,
        name: `${connection.name} ${t('connection.copySuffix')}`,
      };
      // 先持久化新连接
      await useConnectionStore.getState().saveConnection(newConnection);
      // 重新加载连接列表
      await loadConnections();
      // 然后打开新连接
      const newTab = { id: newConnectionId, name: newConnection.name, isConnected: false, isConnecting: true };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabId(newConnectionId);
      connect(newConnection);
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
    // 等待所有断开连接完成
    await Promise.all(tabsToClose.map(tab => disconnect(tab.id)));
    setOpenTabs([openTabs.find(tab => tab.id === tabId)!]);
    setActiveTabId(tabId);
    useConnectionStore.getState().setActiveConnection(tabId);
    setTabContextMenu(null);
  };

  // 关闭所有标签页
  const handleCloseAllTabs = async () => {
    // 等待所有断开连接完成
    await Promise.all(openTabs.map(tab => disconnect(tab.id)));
    setOpenTabs([]);
    setActiveTabId(null);
    useConnectionStore.getState().setActiveConnection(null);
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
      await disconnect(deletingConnection);
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
      if (quickCommandsDropdownRef.current && !quickCommandsDropdownRef.current.contains(e.target as Node)) {
        setShowQuickCommands(false);
      }
    };
    if (tabContextMenu || showConnectionDropdown || showQuickCommands) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [tabContextMenu, showConnectionDropdown, showQuickCommands]);

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

  // 加载快速命令和分组
  const loadQuickCommands = async () => {
    if (window.electronAPI) {
      const [commandsResult, groupsResult] = await Promise.all([
        window.electronAPI.getQuickCommands(),
        window.electronAPI.getQuickCommandGroups(),
      ]);
      if (commandsResult.success) {
        setQuickCommands(Array.isArray(commandsResult.data?.commands) ? commandsResult.data.commands : []);
      }
      if (groupsResult.success) {
        setQuickCommandGroups(Array.isArray(groupsResult.data?.groups) ? groupsResult.data.groups : []);
      }
    }
  };

  // 粘贴命令到终端
  const handlePasteCommand = useCallback((command: string) => {
    if ((window as any).writeToTerminal) {
      (window as any).writeToTerminal(command);
    }
    setShowQuickCommands(false);
  }, []);

  // 保存快速命令
  const handleSaveQuickCommand = async () => {
    if (!newQuickCommand.name || !newQuickCommand.command) return;

    const command: QuickCommand = {
      id: editingQuickCommand?.id || Date.now().toString(),
      name: newQuickCommand.name,
      command: newQuickCommand.command,
      description: newQuickCommand.description,
      groupId: newQuickCommand.groupId || undefined,
    };

    if (window.electronAPI) {
      await window.electronAPI.saveQuickCommand(command);
      await loadQuickCommands();
    }

    setNewQuickCommand({ name: '', command: '', description: '', groupId: '' });
    setEditingQuickCommand(null);
    setShowQuickCommandForm(false);
  };

  // 删除快速命令
  const handleDeleteQuickCommand = async (commandId: string) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteQuickCommand(commandId);
      await loadQuickCommands();
    }
  };

  // 保存分组
  const handleSaveQuickGroup = async () => {
    if (!newQuickGroup.name) return;

    const group: QuickCommandGroup = {
      id: editingQuickGroup?.id || Date.now().toString(),
      name: newQuickGroup.name,
      color: newQuickGroup.color,
    };

    if (window.electronAPI) {
      await window.electronAPI.saveQuickCommandGroup(group);
      await loadQuickCommands();
    }

    setNewQuickGroup({ name: '', color: '#3B82F6' });
    setEditingQuickGroup(null);
    setShowQuickGroupForm(false);
  };

  // 删除分组
  const handleDeleteQuickGroup = async (groupId: string) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteQuickCommandGroup(groupId);
      await loadQuickCommands();
    }
  };

  // 保存设置
  const handleSaveSettings = async (newSettings: AppSettings) => {
    updateSettings(newSettings);
    if (window.electronAPI) {
      await window.electronAPI.saveSettings(newSettings);
    }

    // 同步更新智能体配置
    useAgentStore.getState().syncFromSettings(newSettings);
  };

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="app-header">
        <div className="flex items-center gap-2">
          <div className="app-title-mark">
            <AppIcon className="h-6 w-6" />
          </div>
          <div className="mr-2 leading-tight">
            <h1 className="text-sm font-semibold tracking-wide">AI SSH Client</h1>
            <p className="text-[10px] uppercase text-slate-500 dark:text-slate-500">secure shell workspace</p>
          </div>
          {/* 连接按钮 */}
          <div className="relative" ref={connectionDropdownRef}>
            <button
              onClick={() => setShowConnectionDropdown(!showConnectionDropdown)}
              className="toolbar-button-primary"
            >
              <Plug className="w-4 h-4" />
              {t('connection.connect')}
            </button>
            {/* 连接下拉菜单 */}
            {showConnectionDropdown && (
              <div className="app-popover left-0 w-80 scrollbar-modern">
                <div className="app-popover-header">
                  <span>{t('connection.selectConnection')}</span>
                  <button
                    onClick={() => { setEditingConnection({ id: '', name: '', host: '', port: 22, username: '' }); setShowConnectionDropdown(false); }}
                    className="icon-button h-7 w-7"
                    title={t('connection.newConnection')}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {connections.length === 0 ? (
                  <div className="p-4 text-center text-slate-500 dark:text-slate-400 text-sm">
                    {t('connection.noConnections')}
                  </div>
                ) : (
                  connections.map((conn) => (
                    <div
                      key={conn.id}
                      className="group mx-2 my-1 flex items-center rounded-sm border border-[color-mix(in_srgb,var(--border-color)_68%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] px-2 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
                    >
                      <button
                        onClick={() => { handleConnect(conn.id, conn.name); setShowConnectionDropdown(false); }}
                        className="flex-1 flex items-center gap-2 text-left"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-teal-500/40 bg-teal-500/10">
                          <Server className="w-4 h-4 text-teal-500" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-slate-900 dark:text-white truncate">{conn.name}</div>
                          <div className="text-xs text-slate-500">{conn.username}@{conn.host}:{conn.port}</div>
                        </div>
                      </button>
                      <div className="hidden group-hover:flex items-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingConnection(conn); setShowConnectionDropdown(false); }}
                          className="icon-button h-7 w-7"
                          title={t('common.edit')}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeletingConnection(conn.id); setShowConnectionDropdown(false); }}
                          className="icon-button h-7 w-7 hover:text-red-500 dark:hover:text-red-400"
                          title={t('common.delete')}
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
          {/* 文件传输按钮 - 仅连接时显示 */}
          {activeTabId && (
            <button
              onClick={() => setShowFileTransfer(true)}
              className="toolbar-button"
              title={t('fileTransfer.transfer')}
            >
              <FolderUp className="w-4 h-4" />
              {t('fileTransfer.transfer')}
            </button>
          )}

          {/* 快速命令按钮 */}
          {activeTabId && (
            <div className="relative" ref={quickCommandsDropdownRef}>
              <button
                onClick={() => setShowQuickCommands(!showQuickCommands)}
                className={`toolbar-button ${showQuickCommands ? 'toolbar-button-active' : ''}`}
                title={t('quickCommands.title')}
              >
                <Zap className="w-4 h-4" />
                {t('quickCommands.commands')}
                <ChevronDownIcon className="w-3 h-3" />
              </button>

              {/* 快速命令下拉菜单 */}
              {showQuickCommands && (
                <div className="app-popover scrollbar-modern left-0 w-80">
                  {/* 头部 */}
                  <div className="app-popover-header">
                    <span>{t('quickCommands.title')}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          setShowQuickGroupForm(true);
                          setShowQuickCommandForm(false);
                        }}
                        className="icon-button h-7 w-7"
                        title={t('quickCommands.newGroup')}
                      >
                        <FolderUp className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setShowQuickCommandForm(true);
                          setShowQuickGroupForm(false);
                        }}
                        className="icon-button h-7 w-7"
                        title={t('quickCommands.newCommand')}
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* 新建分组表单 */}
                  {showQuickGroupForm && (
                    <div className="border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] p-3">
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={newQuickGroup.name}
                          onChange={(e) => setNewQuickGroup({ ...newQuickGroup, name: e.target.value })}
                          placeholder={t('quickCommands.groupName')}
                          className="industrial-input w-full py-1"
                        />
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={newQuickGroup.color}
                            onChange={(e) => setNewQuickGroup({ ...newQuickGroup, color: e.target.value })}
                            className="h-8 w-8 cursor-pointer rounded-sm border border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-transparent p-0.5"
                          />
                          <div className="flex-1 flex gap-1">
                            <button
                              onClick={handleSaveQuickGroup}
                              className="industrial-button-primary flex-1 px-2 py-1 text-xs"
                            >
                              {t('common.save')}
                            </button>
                            <button
                              onClick={() => setShowQuickGroupForm(false)}
                              className="industrial-button-secondary flex-1 px-2 py-1 text-xs"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 新建命令表单 */}
                  {showQuickCommandForm && (
                    <div className="border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] p-3">
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={newQuickCommand.name}
                          onChange={(e) => setNewQuickCommand({ ...newQuickCommand, name: e.target.value })}
                          placeholder={t('quickCommands.commandName')}
                          className="industrial-input w-full py-1"
                        />
                        <input
                          type="text"
                          value={newQuickCommand.command}
                          onChange={(e) => setNewQuickCommand({ ...newQuickCommand, command: e.target.value })}
                          placeholder={t('quickCommands.commandContent')}
                          className="industrial-input w-full py-1 font-mono"
                        />
                        <input
                          type="text"
                          value={newQuickCommand.description}
                          onChange={(e) => setNewQuickCommand({ ...newQuickCommand, description: e.target.value })}
                          placeholder={t('quickCommands.description')}
                          className="industrial-input w-full py-1"
                        />
                        {quickCommandGroups.length > 0 && (
                          <select
                            value={newQuickCommand.groupId}
                            onChange={(e) => setNewQuickCommand({ ...newQuickCommand, groupId: e.target.value })}
                            className="industrial-input w-full py-1"
                          >
                            <option value="">{t('quickCommands.noGroup')}</option>
                            {quickCommandGroups.map((group) => (
                              <option key={group.id} value={group.id}>{group.name}</option>
                            ))}
                          </select>
                        )}
                        <div className="flex gap-1">
                          <button
                            onClick={handleSaveQuickCommand}
                            className="industrial-button-primary flex-1 px-2 py-1 text-xs"
                          >
                            {t('common.save')}
                          </button>
                          <button
                            onClick={() => setShowQuickCommandForm(false)}
                            className="industrial-button-secondary flex-1 px-2 py-1 text-xs"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 命令列表 */}
                  <div className="p-2">
                    {quickCommands.length === 0 && !showQuickCommandForm && !showQuickGroupForm ? (
                      <div className="text-center text-slate-500 dark:text-slate-400 text-sm py-4">
                        {t('quickCommands.noCommands')}
                      </div>
                    ) : (
                      <>
                        {/* 按分组显示 */}
                        {quickCommandGroups.map((group) => {
                          const groupCommands = quickCommands.filter(c => c.groupId === group.id);
                          if (groupCommands.length === 0) return null;

                          return (
                            <div key={group.id} className="mb-3">
                              <div className="mb-1 flex items-center justify-between border-b border-[color-mix(in_srgb,var(--border-color)_56%,transparent)] px-2 py-1">
                                <div className="flex items-center gap-2">
                                  <div className="h-3 w-3 rounded-sm border border-white/20" style={{ backgroundColor: group.color }} />
                                  <span className="text-xs font-semibold uppercase text-slate-700 dark:text-slate-300">{group.name}</span>
                                </div>
                                <button
                                  onClick={() => handleDeleteQuickGroup(group.id)}
                                  className="icon-button h-6 w-6 hover:text-red-500"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                              {groupCommands.map((cmd) => (
                                <div
                                  key={cmd.id}
                                  className="group mx-1 flex items-center rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[color-mix(in_srgb,var(--border-color)_62%,transparent)] hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
                                >
                                  <button
                                    onClick={() => handlePasteCommand(cmd.command)}
                                    className="flex-1 text-left"
                                  >
                                    <div className="text-sm text-slate-900 dark:text-white font-medium">{cmd.name}</div>
                                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">{cmd.command}</div>
                                  </button>
                                  <div className="hidden group-hover:flex items-center gap-1">
                                    <button
                                      onClick={() => {
                                        setEditingQuickCommand(cmd);
                                        setNewQuickCommand({ name: cmd.name, command: cmd.command, description: cmd.description || '', groupId: cmd.groupId || '' });
                                        setShowQuickCommandForm(true);
                                      }}
                                      className="icon-button h-6 w-6"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </button>
                                    <button
                                      onClick={() => handleDeleteQuickCommand(cmd.id)}
                                      className="icon-button h-6 w-6 hover:text-red-500"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          );
                        })}

                        {/* 无分组的命令 */}
                        {quickCommands.filter(c => !c.groupId).map((cmd) => (
                          <div
                            key={cmd.id}
                            className="group mx-1 flex items-center rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[color-mix(in_srgb,var(--border-color)_62%,transparent)] hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
                          >
                            <button
                              onClick={() => handlePasteCommand(cmd.command)}
                              className="flex-1 text-left"
                            >
                              <div className="text-sm text-slate-900 dark:text-white font-medium">{cmd.name}</div>
                              <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">{cmd.command}</div>
                            </button>
                            <div className="hidden group-hover:flex items-center gap-1">
                              <button
                                onClick={() => {
                                  setEditingQuickCommand(cmd);
                                  setNewQuickCommand({ name: cmd.name, command: cmd.command, description: cmd.description || '', groupId: cmd.groupId || '' });
                                  setShowQuickCommandForm(true);
                                }}
                                className="icon-button h-6 w-6"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleDeleteQuickCommand(cmd.id)}
                                className="icon-button h-6 w-6 hover:text-red-500"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Theme Toggle */}
          <div className="toolbar-group">
            <button
              onClick={() => changeTheme('light')}
              className={`icon-button h-7 w-7 ${theme === 'light' ? 'icon-button-active' : ''}`}
              title={t('theme.light')}
            >
              <Sun className="w-4 h-4" />
            </button>
            <button
              onClick={() => changeTheme('dark')}
              className={`icon-button h-7 w-7 ${theme === 'dark' ? 'icon-button-active' : ''}`}
              title={t('theme.dark')}
            >
              <Moon className="w-4 h-4" />
            </button>
            <button
              onClick={() => changeTheme('system')}
              className={`icon-button h-7 w-7 ${theme === 'system' ? 'icon-button-active' : ''}`}
              title={t('theme.system')}
            >
              <Monitor className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={() => {
              setSettingsInitialTab('terminal');
              setShowSettings(!showSettings);
            }}
            className={`icon-button ${showSettings ? 'icon-button-active' : ''}`}
            title={t('settings.title')}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Tab Bar */}
      {openTabs.length > 0 && (
        <div className="workspace-tabbar">
          {openTabs.map((tab) => (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, tab.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, tab.id)}
              onDragEnd={handleDragEnd}
              onClick={() => handleTabClick(tab.id)}
              onContextMenu={(e) => handleTabContextMenu(e, tab)}
              className={`workspace-tab group ${
                activeTabId === tab.id
                  ? 'workspace-tab-active'
                  : ''
              } ${dragState.dragOverTabId === tab.id ? 'bg-cyan-50 ring-1 ring-cyan-300 dark:bg-cyan-500/10 dark:ring-cyan-800' : ''} ${
                dragState.isDragging && dragState.draggedTabId === tab.id ? 'opacity-50' : ''
              }`}
            >
              <span className={`status-dot ${
                tab.isConnecting ? 'bg-yellow-500 animate-pulse' :
                tab.isConnected ? 'bg-green-500' : 'bg-slate-500'
              }`} />
              <span className="truncate max-w-32">{tab.name}</span>
              <button
                onClick={(e) => handleCloseTab(e, tab.id)}
                className="opacity-0 group-hover:opacity-100 hover:bg-slate-300 dark:hover:bg-slate-600 rounded p-0.5 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tab右键菜单 */}
      {tabContextMenu && (
        <div
          ref={tabContextMenuRef}
          className="fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[160px]"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
        >
          <button
            onClick={handleCopyConnection}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <Copy className="w-4 h-4" />
            {t('connection.copyConnection')}
          </button>
          <button
            onClick={handleEditConnection}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <Edit3 className="w-4 h-4" />
            {t('connection.editConnection')}
          </button>
          <button
            onClick={handleReconnectTab}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {t('connection.reconnect')}
          </button>
          <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
          <button
            onClick={handleCloseCurrentTab}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
            {t('tab.closeTab')}
          </button>
          <button
            onClick={handleCloseOtherTabs}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
            {t('tab.closeOtherTabs')}
          </button>
          <button
            onClick={handleCloseAllTabs}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <MoreVertical className="w-4 h-4" />
            {t('tab.closeAllTabs')}
          </button>
        </div>
      )}

      {/* Main Content */}
      <div className="app-main">
        {/* Terminal Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <Terminal
            key={activeTabId ?? 'no-connection'}
            connectionId={activeTabId}
            onCommandRequest={handleCommandRequest}
            onPasteToAI={handlePasteToAI}
            theme={theme}
            settings={settings}
          />
        </div>

      </div>

      <AgentPet
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

      {/* Footer */}
      <footer className="app-footer">
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 ${status.color}`}>
            {status.icon}
            <span>{status.text}</span>
          </div>
          {/* 命令执行状态 */}
          {commandStatus && (
            <div className={`flex items-center gap-1 ${
              commandStatus.status === 'pending' ? 'text-yellow-500' :
              commandStatus.status === 'success' ? 'text-green-500' : 'text-red-500'
            }`}>
              {commandStatus.status === 'pending' && <Loader2 className="w-3 h-3 animate-spin" />}
              {commandStatus.status === 'success' && <FileText className="w-3 h-3" />}
              <span className="truncate max-w-48">
                {commandStatus.status === 'pending' ? `⏳ ${commandStatus.command}` : t('notifications.commandCompleted')}
              </span>
            </div>
          )}
        </div>
        <span>AI SSH Client v1.2.0</span>
      </footer>

      {/* Settings Panel */}
      {showSettings && (
        <Suspense fallback={<LazyModalFallback />}>
          <SettingsPanel
            settings={settings}
            onSave={handleSaveSettings}
            onClose={() => setShowSettings(false)}
            initialTab={settingsInitialTab}
          />
        </Suspense>
      )}

      {/* File Transfer Modal */}
      {showFileTransfer && activeTabId && (
        <Suspense fallback={<LazyModalFallback />}>
          <FileTransfer
            connectionId={activeTabId}
            onClose={() => setShowFileTransfer(false)}
          />
        </Suspense>
      )}

      {/* Connection Edit Modal */}
      {editingConnection !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="industrial-modal w-full max-w-md">
            <div className="industrial-modal-header">
              <h3 className="font-semibold text-slate-900 dark:text-white">
                {editingConnection?.id ? t('connection.editConnection') : t('connection.newConnection')}
              </h3>
              <button
                onClick={() => setEditingConnection(null)}
                className="icon-button"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="industrial-field-label">{t('connection.form.name')}</label>
                <input
                  type="text"
                  value={editingConnection?.name || ''}
                  onChange={(e) => setEditingConnection(prev => prev ? { ...prev, name: e.target.value } : null)}
                  className="industrial-input w-full"
                  placeholder="My Server"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="industrial-field-label">{t('connection.form.host')}</label>
                  <input
                    type="text"
                    value={editingConnection?.host || ''}
                    onChange={(e) => setEditingConnection(prev => prev ? { ...prev, host: e.target.value } : null)}
                    className="industrial-input w-full"
                    placeholder="192.168.1.100"
                  />
                </div>
                <div>
                  <label className="industrial-field-label">{t('connection.form.port')}</label>
                  <input
                    type="number"
                    value={editingConnection?.port || 22}
                    onChange={(e) => setEditingConnection(prev => prev ? { ...prev, port: parseInt(e.target.value) || 22 } : null)}
                    className="industrial-input w-full"
                    placeholder="22"
                  />
                </div>
              </div>
              <div>
                <label className="industrial-field-label">{t('connection.form.username')}</label>
                <input
                  type="text"
                  value={editingConnection?.username || ''}
                  onChange={(e) => setEditingConnection(prev => prev ? { ...prev, username: e.target.value } : null)}
                  className="industrial-input w-full"
                  placeholder="root"
                />
              </div>
              <div>
                <label className="industrial-field-label">{t('connection.form.password')}</label>
                <input
                  type="password"
                  value={editingConnection?.password || ''}
                  onChange={(e) => setEditingConnection(prev => prev ? { ...prev, password: e.target.value } : null)}
                  className="industrial-input w-full"
                  placeholder="••••••••"
                />
              </div>
              {/* 测试连接结果 */}
              {connectionTestResult && (
                <div className={`industrial-card flex items-center gap-2 px-3 py-2 ${
                  connectionTestResult.success 
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' 
                    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                }`}>
                  {connectionTestResult.success ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <AlertCircle className="w-4 h-4" />
                  )}
                  <span className="text-sm">{connectionTestResult.message}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                {/* 测试连接按钮 */}
                <button
                  onClick={handleTestConnection}
                  disabled={testingConnection || !editingConnection?.host || !editingConnection?.username}
                  className="industrial-button-secondary"
                >
                  {testingConnection ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Wifi className="w-4 h-4" />
                  )}
                  {t('connection.testConnection')}
                </button>

                {/* 取消和保存按钮 */}
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setEditingConnection(null);
                      setConnectionTestResult(null);
                    }}
                    className="industrial-button-secondary"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={async () => {
                      if (editingConnection?.name && editingConnection?.host && editingConnection?.username) {
                        const connectionToSave = {
                          ...editingConnection,
                          id: editingConnection.id || Date.now().toString(),
                        };
                        await useConnectionStore.getState().saveConnection(connectionToSave);
                        setEditingConnection(null);
                        setConnectionTestResult(null);
                      }
                    }}
                    disabled={!editingConnection?.name || !editingConnection?.host || !editingConnection?.username}
                    className="industrial-button-primary"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingConnection && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="industrial-modal w-full max-w-sm">
            <div className="industrial-modal-header">
              <h3 className="font-semibold text-slate-900 dark:text-white">{t('connection.confirmDeleteTitle')}</h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {t('connection.confirmDelete')}
              </p>
            </div>
            <div className="industrial-modal-footer">
              <button
                onClick={() => setDeletingConnection(null)}
                className="industrial-button-secondary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeleteConnection}
                className="industrial-button-danger"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Command Approval Modal */}
      {pendingCommand && (
        <Suspense fallback={<LazyModalFallback />}>
          <CommandApproval
            command={pendingCommand}
            onApprove={handleApproveCommand}
            onReject={handleRejectCommand}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
