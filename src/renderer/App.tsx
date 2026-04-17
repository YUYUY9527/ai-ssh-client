import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Terminal as TerminalIcon,
  MessageSquare,
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
import { ChatPanel } from './components/ChatPanel';
import { CommandApproval } from './components/CommandApproval';
import { SettingsPanel } from './components/SettingsPanel';
import { FileTransfer } from './components/FileTransfer';
import { useConnectionStore } from './store/useConnectionStore';
import { useAIStore } from './store/useAIStore';
import { useAgentStore } from './store/useAgentStore';
import { useTheme } from './hooks/useTheme';
import type { CommandSuggestion, SSHSessionState, SSHConnection, QuickCommand, QuickCommandGroup } from '../shared/types';
import type { AppSettings } from '../shared/types';

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

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const lastNotificationRef = useRef<string>('');
  const pendingCommandNotificationRef = useRef<{
    connectionId: string;
    command: string;
    timer: ReturnType<typeof setTimeout> | null;
    startedAt: number;
  } | null>(null);
  const [showChatPanel, setShowChatPanel] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [chatInputFocusToken, setChatInputFocusToken] = useState(0);
  const [showFileTransfer, setShowFileTransfer] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<CommandSuggestion | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showConnectionDropdown, setShowConnectionDropdown] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SSHConnection | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{ success: boolean; message: string } | null>(null);
  
  // 侧边栏宽度和拖动状态
  const [chatPanelWidth, setChatPanelWidth] = useState(384); // 默认 384px (w-96)
  const [isResizing, setIsResizing] = useState(false);
  const minChatPanelWidth = 280;
  const maxChatPanelWidth = 600;

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
    if (window.electronAPI) {
      loadConnections();
      loadProviders();
      loadQuickCommands();

      // 监听 SSH 数据
      const cleanupSshData = window.electronAPI.onSshData(({ connectionId, data, type, state }) => {
        if (type === 'state' && state) {
          updateTabState(connectionId, state);
          return;
        }

        if (data) {
          addTerminalOutput(connectionId, data);
          scheduleCommandNotification(connectionId, data);
        }
      });

      // 监听 SSH 错误
      const cleanupSshError = window.electronAPI.onSshError?.(({ connectionId, error }) => {
        addTerminalOutput(connectionId, `\r\n\x1b[31m错误: ${error}\x1b[0m\r\n`);
      });

      // 监听 SSH 关闭
      const cleanupSshClose = window.electronAPI.onSshClose?.((connectionId) => {
        handleConnectionClose(connectionId);
      });

      // 监听系统从睡眠恢复，检查 SSH 连接状态
      const cleanupSystemResume = (window.electronAPI as any).onSystemResume?.(() => {
        console.log('[App] System resumed from sleep, checking SSH connections...');
        // 延迟 2 秒后检查连接状态，给网络恢复一些时间
        setTimeout(async () => {
          const result = await window.electronAPI?.sshGetSessions();
          if (result?.success && result.sessions) {
            const activeSessions = new Set(result.sessions.map((s: any) => s.connectionId));
            // 检查所有已连接的 tab，如果 SSH session 不在了就标记为断开
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
        cleanupSshData();
        cleanupSshError?.();
        cleanupSshClose?.();
        cleanupSystemResume?.();
      };
    }
  }, [loadConnections, loadProviders, addTerminalOutput]);

  useEffect(() => {
    const { updateConfig } = useAgentStore.getState();
    updateConfig({
      enabled: settings.agentEnabled ?? true,
      autoExecute: settings.agentAutoExecute ?? true,
      requireApprovalForRisk: true,
      approveHighRisk: settings.approveHighRisk ?? true,
      approveMediumRisk: settings.approveMediumRisk ?? false,
      maxExecutionSteps: settings.agentMaxExecutionSteps ?? 20,
      maxContextMessages: settings.agentMaxContextMessages ?? 20,
      maxTerminalOutputLength: settings.agentMaxTerminalOutputLength ?? 8000,
      trimContextEnabled: settings.agentTrimContextEnabled ?? true,
    });
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
        setTimeout(() => setCommandStatus(null), 3000);
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
      setTimeout(() => setCommandStatus(null), 2000);
    }
  };

  const handlePasteToAI = useCallback((text: string) => {
    const cleanText = text.replace(/[\r\n]+$/, '');
    if (!cleanText) {
      return;
    }

    setShowChatPanel(true);
    setChatInput((prev) => prev ? `${prev}\n${cleanText}` : cleanText);
    setChatInputFocusToken((prev) => prev + 1);
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
    await window.electronAPI.showSystemNotification('命令执行完成', command, {
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

  const getConnectionStatus = () => {
    const currentTab = openTabs.find(tab => tab.id === activeTabId);
    if (!currentTab) return { icon: <WifiOff className="w-3 h-3" />, text: '未连接', color: 'text-slate-500' };
    if (currentTab.isConnecting) return { icon: <Loader2 className="w-3 h-3 animate-spin" />, text: '连接中...', color: 'text-yellow-500' };
    if (currentTab.isConnected) return { icon: <Wifi className="w-3 h-3" />, text: '已连接', color: 'text-green-500' };
    return { icon: <WifiOff className="w-3 h-3" />, text: '已断开', color: 'text-red-500' };
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
        name: `${connection.name} (副本)`,
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
      setConnectionTestResult({ success: false, message: '请填写主机和用户名' });
      return;
    }

    setTestingConnection(true);
    setConnectionTestResult(null);

    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.sshTestConnection(editingConnection);
        if (result.success) {
          setConnectionTestResult({ success: true, message: '连接成功！' });
        } else {
          setConnectionTestResult({ success: false, message: result.error || '连接失败' });
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

  // 侧边栏拖动处理
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // 监听鼠标移动和松开事件
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const newWidth = window.innerWidth - e.clientX;
      const clampedWidth = Math.min(Math.max(newWidth, minChatPanelWidth), maxChatPanelWidth);
      setChatPanelWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (document.body.style.cursor === 'ew-resize') {
        document.body.style.cursor = '';
      }
      if (document.body.style.userSelect === 'none') {
        document.body.style.userSelect = '';
      }
    };
  }, [isResizing, minChatPanelWidth, maxChatPanelWidth]);

  // 当侧边栏宽度变化时，触发终端重新调整大小
  useEffect(() => {
    if (activeTabId) {
      // 触发窗口 resize 事件，让终端重新计算大小
      window.dispatchEvent(new Event('resize'));
    }
  }, [chatPanelWidth, activeTabId]);

  // 保存设置
  const handleSaveSettings = async (newSettings: AppSettings) => {
    updateSettings(newSettings);
    if (window.electronAPI) {
      await window.electronAPI.saveSettings(newSettings);
    }

    // 同步更新智能体配置
    const { updateConfig } = useAgentStore.getState();
    updateConfig({
      enabled: newSettings.agentEnabled ?? true,
      autoExecute: newSettings.agentAutoExecute ?? true,
      requireApprovalForRisk: true,
      approveHighRisk: newSettings.approveHighRisk ?? true,
      approveMediumRisk: newSettings.approveMediumRisk ?? false,
      maxExecutionSteps: newSettings.agentMaxExecutionSteps ?? 20,
      maxContextMessages: newSettings.agentMaxContextMessages ?? 20,
      maxTerminalOutputLength: newSettings.agentMaxTerminalOutputLength ?? 8000,
      trimContextEnabled: newSettings.agentTrimContextEnabled ?? true,
    });
  };

  return (
    <div className="flex flex-col h-screen bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100">
      {/* Header */}
      <header className="h-12 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center px-4 justify-between">
        <div className="flex items-center gap-3">
          <TerminalIcon className="w-5 h-5 text-blue-500" />
          <h1 className="font-semibold text-sm">AI SSH Client</h1>
          {/* 连接按钮 */}
          <div className="relative" ref={connectionDropdownRef}>
            <button
              onClick={() => setShowConnectionDropdown(!showConnectionDropdown)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm transition-colors"
            >
              <Plug className="w-4 h-4" />
              连接
            </button>
            {/* 连接下拉菜单 */}
            {showConnectionDropdown && (
              <div className="absolute top-full left-0 mt-1 w-80 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-600 scrollbar-track-transparent hover:scrollbar-thumb-slate-400 dark:hover:scrollbar-thumb-slate-500">
                <div className="p-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">选择连接</span>
                  <button
                    onClick={() => { setEditingConnection({ id: '', name: '', host: '', port: 22, username: '' }); setShowConnectionDropdown(false); }}
                    className="p-1 text-blue-500 hover:text-blue-400 transition-colors"
                    title="新建连接"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {connections.length === 0 ? (
                  <div className="p-4 text-center text-slate-500 dark:text-slate-400 text-sm">
                    暂无连接，点击 + 添加
                  </div>
                ) : (
                  connections.map((conn) => (
                    <div
                      key={conn.id}
                      className="group flex items-center px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                    >
                      <button
                        onClick={() => { handleConnect(conn.id, conn.name); setShowConnectionDropdown(false); }}
                        className="flex-1 flex items-center gap-2 text-left"
                      >
                        <Server className="w-4 h-4 text-slate-400" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-slate-900 dark:text-white truncate">{conn.name}</div>
                          <div className="text-xs text-slate-500">{conn.username}@{conn.host}:{conn.port}</div>
                        </div>
                      </button>
                      <div className="hidden group-hover:flex items-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingConnection(conn); setShowConnectionDropdown(false); }}
                          className="p-1.5 text-slate-500 hover:text-blue-500 hover:bg-slate-200 dark:hover:bg-slate-600 rounded transition-colors"
                          title="编辑"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeletingConnection(conn.id); setShowConnectionDropdown(false); }}
                          className="p-1.5 text-slate-500 hover:text-red-500 hover:bg-slate-200 dark:hover:bg-slate-600 rounded transition-colors"
                          title="删除"
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
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded text-slate-700 dark:text-slate-300 text-sm transition-colors"
              title="文件传输"
            >
              <FolderUp className="w-4 h-4" />
              传输
            </button>
          )}

          {/* 快速命令按钮 */}
          {activeTabId && (
            <div className="relative" ref={quickCommandsDropdownRef}>
              <button
                onClick={() => setShowQuickCommands(!showQuickCommands)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded text-slate-700 dark:text-slate-300 text-sm transition-colors"
                title="快速命令"
              >
                <Zap className="w-4 h-4" />
                命令
                <ChevronDownIcon className="w-3 h-3" />
              </button>

              {/* 快速命令下拉菜单 */}
              {showQuickCommands && (
                <div className="absolute top-full left-0 mt-1 w-80 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
                  {/* 头部 */}
                  <div className="p-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400">快速命令</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          setShowQuickGroupForm(true);
                          setShowQuickCommandForm(false);
                        }}
                        className="p-1 text-blue-500 hover:text-blue-400 transition-colors"
                        title="新建分组"
                      >
                        <FolderUp className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setShowQuickCommandForm(true);
                          setShowQuickGroupForm(false);
                        }}
                        className="p-1 text-blue-500 hover:text-blue-400 transition-colors"
                        title="新建命令"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* 新建分组表单 */}
                  {showQuickGroupForm && (
                    <div className="p-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={newQuickGroup.name}
                          onChange={(e) => setNewQuickGroup({ ...newQuickGroup, name: e.target.value })}
                          placeholder="分组名称"
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
                        />
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={newQuickGroup.color}
                            onChange={(e) => setNewQuickGroup({ ...newQuickGroup, color: e.target.value })}
                            className="w-8 h-8 rounded cursor-pointer"
                          />
                          <div className="flex-1 flex gap-1">
                            <button
                              onClick={handleSaveQuickGroup}
                              className="flex-1 px-2 py-1 text-xs bg-blue-500 hover:bg-blue-400 text-white rounded transition-colors"
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setShowQuickGroupForm(false)}
                              className="flex-1 px-2 py-1 text-xs bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded transition-colors"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 新建命令表单 */}
                  {showQuickCommandForm && (
                    <div className="p-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={newQuickCommand.name}
                          onChange={(e) => setNewQuickCommand({ ...newQuickCommand, name: e.target.value })}
                          placeholder="命令名称"
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
                        />
                        <input
                          type="text"
                          value={newQuickCommand.command}
                          onChange={(e) => setNewQuickCommand({ ...newQuickCommand, command: e.target.value })}
                          placeholder="命令内容"
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
                        />
                        <input
                          type="text"
                          value={newQuickCommand.description}
                          onChange={(e) => setNewQuickCommand({ ...newQuickCommand, description: e.target.value })}
                          placeholder="描述（可选）"
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
                        />
                        {quickCommandGroups.length > 0 && (
                          <select
                            value={newQuickCommand.groupId}
                            onChange={(e) => setNewQuickCommand({ ...newQuickCommand, groupId: e.target.value })}
                            className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
                          >
                            <option value="">无分组</option>
                            {quickCommandGroups.map((group) => (
                              <option key={group.id} value={group.id}>{group.name}</option>
                            ))}
                          </select>
                        )}
                        <div className="flex gap-1">
                          <button
                            onClick={handleSaveQuickCommand}
                            className="flex-1 px-2 py-1 text-xs bg-blue-500 hover:bg-blue-400 text-white rounded transition-colors"
                          >
                            保存
                          </button>
                          <button
                            onClick={() => setShowQuickCommandForm(false)}
                            className="flex-1 px-2 py-1 text-xs bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded transition-colors"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 命令列表 */}
                  <div className="p-2">
                    {quickCommands.length === 0 && !showQuickCommandForm && !showQuickGroupForm ? (
                      <div className="text-center text-slate-500 dark:text-slate-400 text-sm py-4">
                        暂无快速命令，点击 + 添加
                      </div>
                    ) : (
                      <>
                        {/* 按分组显示 */}
                        {quickCommandGroups.map((group) => {
                          const groupCommands = quickCommands.filter(c => c.groupId === group.id);
                          if (groupCommands.length === 0) return null;

                          return (
                            <div key={group.id} className="mb-3">
                              <div className="flex items-center justify-between px-2 py-1 mb-1">
                                <div className="flex items-center gap-2">
                                  <div className="w-3 h-3 rounded" style={{ backgroundColor: group.color }} />
                                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{group.name}</span>
                                </div>
                                <button
                                  onClick={() => handleDeleteQuickGroup(group.id)}
                                  className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                              {groupCommands.map((cmd) => (
                                <div
                                  key={cmd.id}
                                  className="group flex items-center px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
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
                                      className="p-1 text-slate-400 hover:text-blue-500 transition-colors"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </button>
                                    <button
                                      onClick={() => handleDeleteQuickCommand(cmd.id)}
                                      className="p-1 text-slate-400 hover:text-red-500 transition-colors"
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
                            className="group flex items-center px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
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
                                className="p-1 text-slate-400 hover:text-blue-500 transition-colors"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleDeleteQuickCommand(cmd.id)}
                                className="p-1 text-slate-400 hover:text-red-500 transition-colors"
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
          <div className="flex items-center bg-slate-200 dark:bg-slate-900 rounded-lg p-1">
            <button
              onClick={() => changeTheme('light')}
              className={`p-1.5 rounded transition-colors ${theme === 'light' ? 'bg-blue-500 text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}
              title="浅色主题"
            >
              <Sun className="w-4 h-4" />
            </button>
            <button
              onClick={() => changeTheme('dark')}
              className={`p-1.5 rounded transition-colors ${theme === 'dark' ? 'bg-blue-500 text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}
              title="深色主题"
            >
              <Moon className="w-4 h-4" />
            </button>
            <button
              onClick={() => changeTheme('system')}
              className={`p-1.5 rounded transition-colors ${theme === 'system' ? 'bg-blue-500 text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}
              title="跟随系统"
            >
              <Monitor className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={() => setShowChatPanel(!showChatPanel)}
            className={`p-2 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors ${showChatPanel ? 'text-blue-500' : 'text-slate-600 dark:text-slate-400'}`}
            title="AI 助手"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-slate-600 dark:text-slate-400"
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Tab Bar */}
      {openTabs.length > 0 && (
        <div className="h-9 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center px-2 gap-1 overflow-x-auto">
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
              className={`flex items-center gap-2 px-3 py-1.5 rounded-t cursor-pointer text-sm transition-all group ${
                activeTabId === tab.id
                  ? 'bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-white border-b-2 border-blue-500'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700'
              } ${dragState.dragOverTabId === tab.id ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-300' : ''} ${
                dragState.isDragging && dragState.draggedTabId === tab.id ? 'opacity-50' : ''
              }`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
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
            复制连接
          </button>
          <button
            onClick={handleEditConnection}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <Edit3 className="w-4 h-4" />
            编辑连接
          </button>
          <button
            onClick={handleReconnectTab}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            重新连接
          </button>
          <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
          <button
            onClick={handleCloseCurrentTab}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
            关闭标签页
          </button>
          <button
            onClick={handleCloseOtherTabs}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
            关闭其他标签页
          </button>
          <button
            onClick={handleCloseAllTabs}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <MoreVertical className="w-4 h-4" />
            关闭所有标签页
          </button>
        </div>
      )}

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Terminal Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <Terminal
            connectionId={activeTabId}
            onCommandRequest={handleCommandRequest}
            onPasteToAI={handlePasteToAI}
            theme={theme}
            settings={settings}
          />
        </div>

        {/* Chat Panel */}
        {showChatPanel && (
          <>
            {/* 拖动柄 - 改为小的可点击区域，避免覆盖滚动条 */}
            <div
              onMouseDown={startResizing}
              className="w-1 bg-slate-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-ew-resize transition-colors relative flex items-center justify-center"
              title="拖动调整宽度"
            >
              {/* 拖动指示点 */}
              <div className={`w-0.5 h-6 rounded-full transition-colors ${
                isResizing 
                  ? 'bg-blue-600 dark:bg-blue-400' 
                  : 'bg-slate-400 dark:bg-slate-500'
              }`} />
            </div>
            {/* 侧边栏内容 */}
            <div 
              className="bg-white dark:bg-slate-800 border-l border-slate-200 dark:border-slate-700 flex flex-col"
              style={{ width: `${chatPanelWidth}px` }}
            >
              <ChatPanel
                onCommandRequest={handleCommandRequest}
                input={chatInput}
                onInputChange={setChatInput}
                focusInputToken={chatInputFocusToken}
              />
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="h-6 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 flex items-center px-4 justify-between text-xs text-slate-500 flex-shrink-0">
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
                {commandStatus.status === 'pending' ? `执行: ${commandStatus.command}` : '命令已执行'}
              </span>
            </div>
          )}
        </div>
        <span>AI SSH Client v1.2.0</span>
      </footer>

      {/* Settings Panel */}
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* File Transfer Modal */}
      {showFileTransfer && activeTabId && (
        <FileTransfer
          connectionId={activeTabId}
          onClose={() => setShowFileTransfer(false)}
        />
      )}

      {/* Connection Edit Modal */}
      {editingConnection !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 w-full max-w-md">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900 dark:text-white">
                {editingConnection?.id ? '编辑连接' : '新建连接'}
              </h3>
              <button
                onClick={() => setEditingConnection(null)}
                className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">连接名称</label>
                <input
                  type="text"
                  value={editingConnection?.name || ''}
                  onChange={(e) => setEditingConnection(prev => prev ? { ...prev, name: e.target.value } : null)}
                  className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                  placeholder="我的服务器"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">主机</label>
                  <input
                    type="text"
                    value={editingConnection?.host || ''}
                    onChange={(e) => setEditingConnection(prev => prev ? { ...prev, host: e.target.value } : null)}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                    placeholder="192.168.1.100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">端口</label>
                  <input
                    type="number"
                    value={editingConnection?.port || 22}
                    onChange={(e) => setEditingConnection(prev => prev ? { ...prev, port: parseInt(e.target.value) || 22 } : null)}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                    placeholder="22"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">用户名</label>
                <input
                  type="text"
                  value={editingConnection?.username || ''}
                  onChange={(e) => setEditingConnection(prev => prev ? { ...prev, username: e.target.value } : null)}
                  className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                  placeholder="root"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">密码</label>
                <input
                  type="password"
                  value={editingConnection?.password || ''}
                  onChange={(e) => setEditingConnection(prev => prev ? { ...prev, password: e.target.value } : null)}
                  className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                  placeholder="••••••••"
                />
              </div>
              {/* 测试连接结果 */}
              {connectionTestResult && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded ${
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
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors text-slate-900 dark:text-white"
                >
                  {testingConnection ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Wifi className="w-4 h-4" />
                  )}
                  测试连接
                </button>

                {/* 取消和保存按钮 */}
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setEditingConnection(null);
                      setConnectionTestResult(null);
                    }}
                    className="px-4 py-2 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition-colors text-slate-900 dark:text-white"
                  >
                    取消
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
                    className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors text-white"
                  >
                    保存
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
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 w-full max-w-sm">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700">
              <h3 className="font-semibold text-slate-900 dark:text-white">确认删除</h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                确定要删除这个连接配置吗？此操作无法撤销。
              </p>
            </div>
            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
              <button
                onClick={() => setDeletingConnection(null)}
                className="px-4 py-2 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition-colors text-slate-900 dark:text-white"
              >
                取消
              </button>
              <button
                onClick={handleDeleteConnection}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 rounded transition-colors text-white"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Command Approval Modal */}
      {pendingCommand && (
        <CommandApproval
          command={pendingCommand}
          onApprove={handleApproveCommand}
          onReject={handleRejectCommand}
        />
      )}
    </div>
  );
}

export default App;
