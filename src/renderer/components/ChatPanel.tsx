import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Settings, Plus, Trash2, Sparkles, History, Clock, X, RotateCcw, Cpu, Zap, Key } from 'lucide-react';
import { useAIStore } from '../store/useAIStore';
import { useConnectionStore } from '../store/useConnectionStore';
import { useAgentStore } from '../store/useAgentStore';
import { AIMessageContent } from './AIMessageContent';
import { AgentThinking } from './AgentThinking';
import { AgentExecutor } from './AgentExecutor';
import { ConfirmDialog } from './ConfirmDialog';
import { COMMAND_DESCRIPTIONS } from '../../shared/constants';
import type { AIProviderConfig, AIProviderType, CommandHistoryItem, AIProviderSummary } from '../../shared/types';

interface ChatPanelProps {
  onCommandRequest?: (command: string) => void;
  input: string;
  onInputChange: (value: string) => void;
  focusInputToken?: number;
}

interface ProviderFormState {
  name: string;
  type: AIProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface ProviderSecretState {
  hasApiKey: boolean;
  maskedApiKey?: string;
  isLoading: boolean;
}

const EMPTY_PROVIDER_FORM: ProviderFormState = {
  name: '',
  type: 'openai',
  apiKey: '',
  baseUrl: '',
  model: '',
};

function getProviderTypeLabel(type: AIProviderType): string {
  switch (type) {
    case 'openai':
      return 'OpenAI';
    case 'openai-compatible':
      return 'OpenAI Compatible';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    case 'ollama':
      return 'Ollama';
    default:
      return type;
  }
}

export function ChatPanel({ onCommandRequest, input, onInputChange, focusInputToken = 0 }: ChatPanelProps) {
  const [showProviderSettings, setShowProviderSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AIProviderSummary | null>(null);
  const [commandHistory, setCommandHistory] = useState<CommandHistoryItem[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [toastInfo, setToastInfo] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [providerSecretState, setProviderSecretState] = useState<ProviderSecretState>({
    hasApiKey: false,
    maskedApiKey: undefined,
    isLoading: false,
  });
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const providerTestResultRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    providers,
    activeProviderId,
    messages,
    isLoading,
    error,
    loadProviders,
    saveProvider,
    deleteProvider,
    setActiveProvider,
    sendMessage,
    clearMessages,
    clearError,
  } = useAIStore();

  const {
    activeConnectionId,
  } = useConnectionStore();

  const {
    mode,
    setMode,
    currentTask,
    agentState,
    pendingApproval,
    pendingQuestion,
    setPendingApproval,
    setApprovalResult,
    setPendingQuestion,
    setPendingInput,
    startTask,
    pauseTask,
    resumeTask,
    cancelTask,
    addThinkingStep,
    updateThinkingStep,
    addExecution,
    completeTask,
    reset,
  } = useAgentStore();

  const [providerForm, setProviderForm] = useState<ProviderFormState>(EMPTY_PROVIDER_FORM);

  const scrollProviderEditorToBottom = useCallback(() => {
    const container = contentScrollRef.current;
    if (!container) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      });
    });
  }, []);

  const getCommandDescription = (command: string): string | null => {
    const parts = command.trim().split(/\s+/);
    const baseCmd = parts[0];

    if (COMMAND_DESCRIPTIONS[command]) {
      return COMMAND_DESCRIPTIONS[command];
    }

    for (let i = parts.length; i >= 1; i--) {
      const partial = parts.slice(0, i).join(' ');
      if (COMMAND_DESCRIPTIONS[partial]) {
        return COMMAND_DESCRIPTIONS[partial];
      }
    }

    if (COMMAND_DESCRIPTIONS[baseCmd]) {
      return COMMAND_DESCRIPTIONS[baseCmd];
    }

    return null;
  };

  const loadProviderSecretState = useCallback(async (providerId: string) => {
    if (!window.electronAPI || !providerId) return;

    setProviderSecretState((prev) => ({ ...prev, isLoading: true }));
    const result = await window.electronAPI.getAIProviderSecretStatus(providerId);

    if (result.success && result.data) {
      setProviderSecretState({
        hasApiKey: result.data.hasApiKey,
        maskedApiKey: result.data.maskedApiKey,
        isLoading: false,
      });
      return;
    }

    setProviderSecretState({
      hasApiKey: false,
      maskedApiKey: undefined,
      isLoading: false,
    });
  }, []);

  const resetProviderEditor = useCallback(() => {
    setEditingProvider(null);
    setProviderForm(EMPTY_PROVIDER_FORM);
    setProviderSecretState({ hasApiKey: false, maskedApiKey: undefined, isLoading: false });
    setShowApiKey(false);
    setLocalError(null);
    setIsTestingConnection(false);
  }, []);

  const handleModeChange = (newMode: 'assistant' | 'agent') => {
    if (agentState !== 'idle') {
      const message = newMode === 'agent'
        ? '切换模式会终止当前任务，确定吗？'
        : '切换到助手模式会终止当前智能体任务，确定吗？';

      setConfirmDialog({
        isOpen: true,
        title: '切换模式',
        message,
        onConfirm: () => {
          reset();
          useAIStore.getState().clearError();
          useAIStore.setState({ isLoading: false });
          setMode(newMode);
          setConfirmDialog({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        },
      });
      return;
    }
    useAIStore.getState().clearError();
    useAIStore.setState({ isLoading: false });
    setMode(newMode);
  };

  const handleRetryTask = () => {
    if (!currentTask) return;
    reset();
    setTimeout(() => {
      startTask(currentTask.userInput);
    }, 100);
  };

  const handleClearConversation = () => {
    onInputChange('');
    setLocalError(null);
    setToastInfo(null);
    clearError();
    clearMessages();
    reset();
  };

  const handleApproveCommand = () => {
    setApprovalResult('approved');
  };

  const handleRejectCommand = () => {
    setApprovalResult('rejected');
  };

  const handlePasteToTerminal = useCallback((command: string) => {
    if ((window as any).writeToTerminal) {
      (window as any).writeToTerminal(command);
    }
  }, []);

  const handleExecuteCommand = useCallback((command: string) => {
    const riskAnalysis = useAIStore.getState().analyzeCommand(command);

    if (riskAnalysis.riskLevel === 'high' || riskAnalysis.riskLevel === 'critical') {
      if (onCommandRequest) {
        onCommandRequest(command);
      }
    } else {
      const { executeCommand, activeConnectionId } = useConnectionStore.getState();
      if (activeConnectionId && executeCommand) {
        executeCommand(command);
      }
    }
  }, [onCommandRequest]);

  useEffect(() => {
    const { isLoading } = useAIStore.getState();
    if (isLoading) {
      useAIStore.setState({ isLoading: false, error: null });
    }

    loadProviders();
    loadCommandHistory();
  }, []);

  useEffect(() => {
    if (showProviderSettings || showHistory) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, showProviderSettings, showHistory]);

  useEffect(() => {
    if (focusInputToken > 0 && !showProviderSettings && !showHistory) {
      inputRef.current?.focus();
    }
  }, [focusInputToken, showProviderSettings, showHistory]);

  const scrollToTop = () => {
    if (contentScrollRef.current) {
      contentScrollRef.current.scrollTop = 0;
    }
  };

  const loadCommandHistory = async () => {
    if (window.electronAPI) {
      const result = await window.electronAPI.getCommandHistory();
      if (result.success && result.data) {
        setCommandHistory(result.data.history);
      }
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !activeProviderId) {
      return;
    }
    setLocalError(null);
    const userInput = input;
    onInputChange('');

    if (mode === 'agent') {
      if (agentState === 'paused' && pendingQuestion) {
        useAgentStore.setState({ pendingInput: userInput });
      } else if (!currentTask || agentState === 'finished') {
        reset();
        setTimeout(() => {
          startTask(userInput);
        }, 0);
      }
    } else {
      await sendMessage(userInput);
    }
  };

  const startAgentTask = async (userInput: string) => {
    if (!activeConnectionId) {
      setToastInfo({ message: '请先连接到 SSH 服务器', type: 'error' });
      return;
    }

    startTask(userInput);
  };

  const testConnection = async () => {
    const hasExistingSecret = Boolean(editingProvider?.id && providerSecretState.hasApiKey);
    const hasNewApiKey = providerForm.apiKey.trim().length > 0;

    if (!providerForm.baseUrl.trim()) {
      setLocalError('请填写 API 地址');
      return;
    }

    if (!hasExistingSecret && !hasNewApiKey) {
      setLocalError('请填写 API Key');
      return;
    }

    setIsTestingConnection(true);
    clearError();
    setLocalError(null);

    try {
      const testProvider: AIProviderConfig = {
        id: editingProvider?.id || `test-${Date.now()}`,
        name: providerForm.name || '测试供应商',
        type: providerForm.type,
        apiKey: providerForm.apiKey.trim() || undefined,
        baseUrl: providerForm.baseUrl.trim(),
        model: providerForm.model.trim() || undefined,
        isActive: false,
      };

      const result = await window.electronAPI.testAIProvider(testProvider);

      if (result.success) {
        setToastInfo({ message: '连接测试成功！', type: 'success' });
      } else {
        setLocalError(`连接失败: ${result.error || '未知错误'}`);
      }
    } catch (err) {
      setLocalError(`连接失败: ${(err as Error).message}`);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAddProvider = () => {
    resetProviderEditor();
    setEditingProvider({
      id: '',
      name: '',
      type: 'openai',
      baseUrl: '',
      model: '',
      isActive: false,
      hasApiKey: false,
      maskedApiKey: undefined,
    });
    setShowProviderSettings(true);
  };

  const handleEditProvider = async (provider: AIProviderSummary) => {
    resetProviderEditor();
    setEditingProvider(provider);
    setProviderForm({
      name: provider.name,
      type: provider.type,
      apiKey: '',
      baseUrl: provider.baseUrl || '',
      model: provider.model || '',
    });
    setShowProviderSettings(true);

    if (provider.id) {
      await loadProviderSecretState(provider.id);
    }
  };

  const handleSaveProvider = async () => {
    if (!providerForm.name.trim()) {
      setLocalError('请填写供应商名称');
      return;
    }

    const provider: AIProviderConfig = {
      id: editingProvider?.id || Date.now().toString(),
      name: providerForm.name.trim(),
      type: providerForm.type,
      apiKey: providerForm.apiKey.trim() || undefined,
      baseUrl: providerForm.baseUrl.trim() || undefined,
      model: providerForm.model.trim() || undefined,
      isActive: editingProvider?.isActive ?? providers.length === 0,
    };

    await saveProvider(provider);
    resetProviderEditor();
    setShowProviderSettings(false);
  };

  const handleDeleteProvider = async (providerId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: '删除供应商',
      message: '确定要删除这个AI供应商吗？',
      onConfirm: async () => {
        await deleteProvider(providerId);
        if (editingProvider?.id === providerId) {
          resetProviderEditor();
        }
        setConfirmDialog({ isOpen: false, title: '', message: '', onConfirm: () => {} });
      },
    });
  };

  const handleSetActive = async (providerId: string) => {
    if (window.electronAPI) {
      const result = await window.electronAPI.setActiveAIProvider(providerId);
      if (!result.success) {
        setToastInfo({ message: result.error || '激活供应商失败', type: 'error' });
        return;
      }
    }
    await loadProviders();
    setActiveProvider(providerId);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  useEffect(() => {
    if (!toastInfo) return;
    const timer = setTimeout(() => setToastInfo(null), 3000);
    return () => clearTimeout(timer);
  }, [toastInfo]);

  useEffect(() => {
    if (!showProviderSettings || (!localError && !toastInfo)) {
      return;
    }
    providerTestResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [localError, toastInfo, showProviderSettings]);

  useEffect(() => {
    if (!showProviderSettings || editingProvider === null) {
      return;
    }
    scrollProviderEditorToBottom();
  }, [editingProvider, showProviderSettings, scrollProviderEditorToBottom]);

  useEffect(() => {
    if (!showProviderSettings || editingProvider === null) {
      return;
    }
    if (providerSecretState.isLoading) {
      return;
    }
    scrollProviderEditorToBottom();
  }, [editingProvider, providerSecretState.hasApiKey, providerSecretState.isLoading, showProviderSettings, scrollProviderEditorToBottom]);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-800">
      <div className="p-3 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-500" />
            <span className="font-medium text-slate-900 dark:text-white">AI 助手</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className={`p-1.5 rounded transition-colors ${showHistory ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700'}`}
              title="命令历史"
            >
              <History className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setShowProviderSettings(!showProviderSettings);
                setShowHistory(false);
                if (!showProviderSettings) {
                  resetProviderEditor();
                }
              }}
              className={`p-1.5 rounded transition-colors ${showProviderSettings ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700'}`}
              title="供应商配置"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => handleModeChange('agent')}
            className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${mode === 'agent' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}`}
          >
            智能体模式
          </button>
          <button
            onClick={() => handleModeChange('assistant')}
            className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${mode === 'assistant' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}`}
          >
            助手模式
          </button>
        </div>

        {!showProviderSettings && !showHistory && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Key className="w-4 h-4 text-slate-400" />
              {providers.length === 0 ? (
                <span className="text-sm text-slate-500 dark:text-slate-400">未配置 AI 供应商</span>
              ) : (
                <span className="text-sm text-slate-600 dark:text-slate-300 truncate">
                  当前供应商：{providers.find((provider) => provider.id === activeProviderId)?.name || '未激活'}
                </span>
              )}
            </div>
          </div>
        )}

      </div>

      <div ref={contentScrollRef} className="flex-1 overflow-y-auto scrollbar-modern pr-1 p-3 space-y-3">
        {!showProviderSettings && !showHistory && (
          <>
            {mode === 'agent' && (
              <AgentThinking
                onPause={pauseTask}
                onResume={resumeTask}
                onCancel={cancelTask}
                onRetry={handleRetryTask}
              />
            )}
            {mode === 'agent' && <AgentExecutor />}

            {messages.map((message) => (
              <div key={message.id} className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}>
                {message.role !== 'user' && (
                  <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
                    <Bot className="w-4 h-4 text-slate-600 dark:text-slate-300" />
                  </div>
                )}
                <div className={`max-w-[85%] ${message.role === 'user' ? 'order-first' : ''}`}>
                  <div className={`p-3 rounded-lg border ${message.role === 'user' ? 'bg-blue-600 text-white border-blue-500 rounded-tr-none' : 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-700 rounded-tl-none'}`}>
                    {message.role === 'user' ? (
                      <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                    ) : (
                      <AIMessageContent
                        content={message.content}
                        onPasteCommand={handlePasteToTerminal}
                        onExecuteCommand={handleExecuteCommand}
                      />
                    )}
                  </div>
                </div>
                {message.role === 'user' && (
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <User className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
                  <Bot className="w-4 h-4 text-slate-600 dark:text-slate-300" />
                </div>
                <div className="p-3 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg rounded-tl-none">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-slate-400 dark:bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-slate-400 dark:bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-slate-400 dark:bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <button
                      onClick={() => useAIStore.getState().cancelMessage()}
                      className="ml-2 px-2 py-0.5 text-xs text-slate-500 dark:text-slate-400 hover:text-red-500 dark:hover:text-red-400 border border-slate-300 dark:border-slate-600 rounded transition-colors"
                      title="停止生成"
                    >
                      停止
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {showHistory && (
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-900 dark:text-white">命令历史</h3>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    await window.electronAPI.clearCommandHistory();
                    await loadCommandHistory();
                  }}
                  className="text-xs text-slate-500 dark:text-slate-400 hover:text-red-500"
                >
                  清空
                </button>
                <button
                  onClick={() => setShowHistory(false)}
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {commandHistory.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">暂无命令历史</p>
            ) : (
              commandHistory.slice(0, 50).map((item) => (
                <div
                  key={item.id}
                  className="p-2 bg-slate-50 dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 cursor-pointer transition-colors"
                  onClick={() => handleExecuteCommand(item.command)}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTime(item.timestamp)}
                    </span>
                    <span className="text-xs text-slate-400 dark:text-slate-600">{item.connectionName}</span>
                  </div>
                  <code className="text-sm text-green-600 dark:text-green-400 font-mono">{item.command}</code>
                </div>
              ))
            )}
          </div>
        )}

        {showProviderSettings && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-slate-900 dark:text-white">AI 供应商配置</h3>
              <button
                onClick={() => {
                  resetProviderEditor();
                  setShowProviderSettings(false);
                }}
                className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex justify-between items-center">
              <h4 className="text-sm font-medium text-slate-500 dark:text-slate-400">已配置的供应商</h4>
              <button
                onClick={handleAddProvider}
                className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400"
              >
                <Plus className="w-3 h-3" />
                添加
              </button>
            </div>

            <div className="space-y-2">
              {providers.map((provider) => (
                <div
                  key={provider.id}
                  className={`p-3 rounded border transition-colors ${provider.isActive ? 'border-blue-500 bg-blue-500/10' : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${provider.isActive ? 'bg-green-500' : 'bg-slate-400 dark:bg-slate-500'}`} />
                        <span className="font-medium text-sm text-slate-900 dark:text-white truncate">{provider.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                          {getProviderTypeLabel(provider.type)}
                        </span>
                      </div>
                      {provider.model && (
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">模型: {provider.model}</p>
                      )}
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        API Key：{provider.hasApiKey ? (provider.maskedApiKey || '已配置') : '未配置'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!provider.isActive && (
                        <button
                          onClick={() => handleSetActive(provider.id)}
                          className="px-2 py-1 text-xs bg-green-600 hover:bg-green-500 rounded transition-colors text-white"
                        >
                          激活
                        </button>
                      )}
                      <button
                        onClick={() => handleEditProvider(provider)}
                        className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDeleteProvider(provider.id)}
                        className="p-1 text-slate-500 dark:text-slate-400 hover:text-red-500 rounded transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {editingProvider !== null && (
              <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700 space-y-3">
                <h4 className="text-sm font-medium text-slate-900 dark:text-white">
                  {editingProvider.id ? '编辑供应商' : '添加供应商'}
                </h4>
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">名称</label>
                  <input
                    type="text"
                    value={providerForm.name}
                    onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                    placeholder="例如：OpenAI"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">类型</label>
                  <select
                    value={providerForm.type}
                    onChange={(e) => setProviderForm({ ...providerForm, type: e.target.value as AIProviderType })}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="openai-compatible">OpenAI Compatible</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Gemini</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">API Key</label>
                  {editingProvider.id && providerSecretState.hasApiKey && (
                    <div className="mb-2 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                      <div className="flex items-center justify-between gap-2">
                        <span>
                          当前已保存密钥：{providerSecretState.isLoading ? '读取中...' : (providerSecretState.maskedApiKey || '已配置')}
                        </span>
                        <span className="text-emerald-600/80 dark:text-emerald-300/80">留空则保留原密钥</span>
                      </div>
                    </div>
                  )}
                  {!editingProvider.id && (
                    <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">新建供应商时将保存你输入的 API Key。</p>
                  )}
                  <div className="relative">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={providerForm.apiKey}
                      onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                      className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 pr-10 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                      placeholder={editingProvider.id && providerSecretState.hasApiKey ? '留空以保留当前 API Key，输入新值可覆盖' : 'sk-...'}
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                    >
                      {showApiKey ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">API 地址</label>
                  <input
                    type="text"
                    value={providerForm.baseUrl}
                    onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">模型</label>
                  <input
                    type="text"
                    value={providerForm.model}
                    onChange={(e) => setProviderForm({ ...providerForm, model: e.target.value })}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                    placeholder="gpt-4o-mini"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={testConnection}
                    disabled={isTestingConnection}
                    className="px-4 py-2 text-sm bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors text-white"
                  >
                    {isTestingConnection ? '测试中...' : '测试连接'}
                  </button>
                  <button
                    onClick={resetProviderEditor}
                    className="px-4 py-2 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition-colors text-slate-900 dark:text-white"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSaveProvider}
                    className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors text-white"
                  >
                    保存
                  </button>
                </div>
                {(localError || toastInfo) && (
                  <div ref={providerTestResultRef} className="space-y-2">
                    {localError && (
                      <div className="p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg flex items-center justify-between">
                        <span className="text-xs text-red-600 dark:text-red-400">{localError}</span>
                        <button onClick={() => setLocalError(null)} className="text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                    {toastInfo && (
                      <div className={`p-2 rounded-lg text-xs ${toastInfo.type === 'success' ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400' : toastInfo.type === 'error' ? 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400' : 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'}`}>
                        {toastInfo.message}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {pendingApproval && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-4 max-w-md w-full mx-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                <svg className="w-4 h-4 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="font-semibold text-slate-900 dark:text-white">命令需要审批</h3>
            </div>

            <div className="mb-4">
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">风险等级</p>
              <span className={`inline-block px-2 py-1 text-xs rounded ${
                pendingApproval.riskLevel === 'critical' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                pendingApproval.riskLevel === 'high' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                pendingApproval.riskLevel === 'medium' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              }`}>
                {pendingApproval.riskLevel === 'critical' ? '极度危险' : pendingApproval.riskLevel === 'high' ? '高风险' : pendingApproval.riskLevel === 'medium' ? '中等风险' : '低风险'}
              </span>
            </div>

            <div className="mb-4 p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">命令</p>
              <code className="text-sm font-mono text-red-600 dark:text-red-400 break-all">{pendingApproval.command}</code>
              {getCommandDescription(pendingApproval.command) && (
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-2 flex items-start gap-1">
                  <span className="text-slate-500 dark:text-slate-400">💡</span>
                  <span>{getCommandDescription(pendingApproval.command)}</span>
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleRejectCommand}
                className="flex-1 px-3 py-2 text-sm bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
              >
                拒绝
              </button>
              <button
                onClick={handleApproveCommand}
                className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${
                  pendingApproval.riskLevel === 'critical' ? 'bg-red-600 hover:bg-red-500' : pendingApproval.riskLevel === 'high' ? 'bg-orange-600 hover:bg-orange-500' : 'bg-blue-600 hover:bg-blue-500'
                } text-white`}
              >
                批准执行
              </button>
            </div>
          </div>
        </div>
      )}

      {!showProviderSettings && !showHistory && (
        <div className="p-3 border-t border-slate-200 dark:border-slate-700">
          {(error || localError) && (
            <div className="mb-2 p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg flex items-center justify-between">
              <span className="text-xs text-red-600 dark:text-red-400">{error || localError}</span>
              <button onClick={() => { clearError(); setLocalError(null); }} className="text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {toastInfo && (
            <div className={`mb-2 p-2 rounded-lg text-xs ${toastInfo.type === 'success' ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400' : toastInfo.type === 'error' ? 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400' : 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'}`}>
              {toastInfo.message}
            </div>
          )}

          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeProviderId ? (mode === 'agent' ? '描述你要完成的任务...' : '询问 Linux 命令问题...') : '请先配置并激活 AI 供应商'}
              disabled={isLoading || !activeProviderId}
              rows={3}
              className="flex-1 resize-none overflow-y-auto bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:opacity-50 disabled:cursor-not-allowed [scrollbar-width:thin] [scrollbar-color:rgba(148,163,184,0.45)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300/70 dark:[&::-webkit-scrollbar-thumb]:bg-slate-600/70 [&::-webkit-scrollbar-thumb]:hover:bg-slate-400/80 dark:[&::-webkit-scrollbar-thumb]:hover:bg-slate-500/80"
            />
            <div className="flex flex-col gap-2">
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading || !activeProviderId}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors text-white"
              >
                <Send className="w-4 h-4" />
              </button>
              <button
                onClick={handleClearConversation}
                className="px-3 py-2 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded-lg transition-colors text-slate-600 dark:text-slate-300"
                title="清空对话"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
      />
    </div>
  );
}
