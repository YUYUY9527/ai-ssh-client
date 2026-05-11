import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Pencil, Plus, Power, Trash2, X } from 'lucide-react';
import { useAIStore } from '../store/useAIStore';
import { ConfirmDialog } from './ConfirmDialog';
import type { AIProviderConfig, AIProviderSummary, AIProviderType } from '../../shared/types';

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

export function AIProviderSettings() {
  const {
    providers,
    activeProviderId,
    loadProviders,
    saveProvider,
    deleteProvider,
    setActiveProvider,
  } = useAIStore();

  const [editingProvider, setEditingProvider] = useState<AIProviderSummary | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderFormState>(EMPTY_PROVIDER_FORM);
  const [providerSecretState, setProviderSecretState] = useState<ProviderSecretState>({
    hasApiKey: false,
    maskedApiKey: undefined,
    isLoading: false,
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmProviderId, setConfirmProviderId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

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

    setProviderSecretState({ hasApiKey: false, maskedApiKey: undefined, isLoading: false });
  }, []);

  const resetProviderEditor = useCallback(() => {
    setEditingProvider(null);
    setProviderForm(EMPTY_PROVIDER_FORM);
    setProviderSecretState({ hasApiKey: false, maskedApiKey: undefined, isLoading: false });
    setShowApiKey(false);
    setStatusMessage(null);
    setIsTestingConnection(false);
  }, []);

  const handleAddProvider = () => {
    resetProviderEditor();
    setEditingProvider({
      id: '',
      name: '',
      type: 'openai',
      baseUrl: '',
      model: '',
      isActive: providers.length === 0,
      hasApiKey: false,
      maskedApiKey: undefined,
    });
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
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
    await loadProviderSecretState(provider.id);
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const testConnection = async () => {
    const hasExistingSecret = Boolean(editingProvider?.id && providerSecretState.hasApiKey);
    const hasNewApiKey = providerForm.apiKey.trim().length > 0;

    if (!providerForm.baseUrl.trim()) {
      setStatusMessage({ type: 'error', text: '请填写 API 地址' });
      return;
    }

    if (!hasExistingSecret && !hasNewApiKey) {
      setStatusMessage({ type: 'error', text: '请填写 API Key' });
      return;
    }

    setIsTestingConnection(true);
    setStatusMessage(null);

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
        setStatusMessage({ type: 'success', text: '连接测试成功' });
      } else {
        setStatusMessage({ type: 'error', text: result.error || '连接测试失败' });
      }
    } catch (error) {
      setStatusMessage({ type: 'error', text: error instanceof Error ? error.message : '连接测试失败' });
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleSaveProvider = async () => {
    if (!editingProvider) return;
    if (!providerForm.name.trim()) {
      setStatusMessage({ type: 'error', text: '请填写供应商名称' });
      return;
    }

    const provider: AIProviderConfig = {
      id: editingProvider.id || Date.now().toString(),
      name: providerForm.name.trim(),
      type: providerForm.type,
      apiKey: providerForm.apiKey.trim() || undefined,
      baseUrl: providerForm.baseUrl.trim() || undefined,
      model: providerForm.model.trim() || undefined,
      isActive: editingProvider.isActive || providers.length === 0,
    };

    await saveProvider(provider);
    await loadProviders();
    resetProviderEditor();
  };

  const handleSetActive = async (providerId: string) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.setActiveAIProvider(providerId);
    if (!result.success) {
      setStatusMessage({ type: 'error', text: result.error || '激活供应商失败' });
      return;
    }
    await loadProviders();
    setActiveProvider(providerId);
  };

  const handleDeleteProvider = async () => {
    if (!confirmProviderId) return;
    await deleteProvider(confirmProviderId);
    if (editingProvider?.id === confirmProviderId) {
      resetProviderEditor();
    }
    setConfirmProviderId(null);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium text-slate-900 dark:text-white">AI 供应商</h3>
          <p className="mt-1 text-xs text-slate-500">智能体只使用这里激活的供应商，不再在聊天窗口里配置。</p>
        </div>
        <button onClick={handleAddProvider} className="industrial-button-primary px-3 py-1.5">
          <Plus className="h-4 w-4" />
          添加供应商
        </button>
      </div>

      <div className="grid gap-3">
        {providers.length === 0 ? (
          <div className="industrial-card p-5 text-center">
            <KeyRound className="mx-auto mb-2 h-6 w-6 text-slate-400" />
            <p className="text-sm text-slate-500">还没有配置 AI 供应商。</p>
          </div>
        ) : (
          providers.map((provider) => (
            <div
              key={provider.id}
              className={`industrial-card p-3 ${provider.id === activeProviderId ? 'border-teal-500/70 bg-teal-500/10' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${provider.id === activeProviderId ? 'bg-green-500' : 'bg-slate-500'}`} />
                    <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">{provider.name}</span>
                    <span className="rounded-sm border border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] px-1.5 py-0.5 text-[10px] text-slate-500">
                      {getProviderTypeLabel(provider.type)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {provider.model || '未指定模型'} · API Key {provider.hasApiKey ? provider.maskedApiKey || '已配置' : '未配置'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {provider.id !== activeProviderId && (
                    <button onClick={() => void handleSetActive(provider.id)} className="icon-button h-8 w-8" title="激活">
                      <Power className="h-4 w-4" />
                    </button>
                  )}
                  <button onClick={() => void handleEditProvider(provider)} className="icon-button h-8 w-8" title="编辑">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => setConfirmProviderId(provider.id)} className="icon-button h-8 w-8 hover:text-red-500" title="删除">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {editingProvider && (
        <div ref={formRef} className="industrial-card p-4">
          <div className="mb-4 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-900 dark:text-white">
              {editingProvider.id ? '编辑供应商' : '添加供应商'}
            </h4>
            <button onClick={resetProviderEditor} className="icon-button h-7 w-7">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="industrial-field-label">名称</label>
              <input
                value={providerForm.name}
                onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
                className="industrial-input w-full"
                placeholder="OpenAI"
              />
            </div>
            <div>
              <label className="industrial-field-label">类型</label>
              <select
                value={providerForm.type}
                onChange={(e) => setProviderForm({ ...providerForm, type: e.target.value as AIProviderType })}
                className="industrial-input w-full"
              >
                <option value="openai">OpenAI</option>
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="industrial-field-label">API Key</label>
              {editingProvider.id && providerSecretState.hasApiKey && (
                <div className="mb-2 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-300">
                  当前已保存密钥：{providerSecretState.isLoading ? '读取中...' : providerSecretState.maskedApiKey || '已配置'}，留空则保留。
                </div>
              )}
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={providerForm.apiKey}
                  onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                  className="industrial-input w-full pr-10"
                  placeholder={editingProvider.id && providerSecretState.hasApiKey ? '留空以保留当前 API Key' : 'sk-...'}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="icon-button absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="industrial-field-label">API 地址</label>
              <input
                value={providerForm.baseUrl}
                onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                className="industrial-input w-full"
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <label className="industrial-field-label">模型</label>
              <input
                value={providerForm.model}
                onChange={(e) => setProviderForm({ ...providerForm, model: e.target.value })}
                className="industrial-input w-full"
                placeholder="gpt-4o-mini"
              />
            </div>
          </div>

          {statusMessage && (
            <div className={`mt-3 flex items-center gap-2 rounded-sm border px-3 py-2 text-xs ${
              statusMessage.type === 'success'
                ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-300'
                : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300'
            }`}>
              {statusMessage.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
              {statusMessage.text}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => void testConnection()} disabled={isTestingConnection} className="industrial-button-secondary">
              {isTestingConnection && <Loader2 className="h-4 w-4 animate-spin" />}
              测试连接
            </button>
            <button onClick={resetProviderEditor} className="industrial-button-secondary">取消</button>
            <button onClick={() => void handleSaveProvider()} className="industrial-button-primary">保存</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmProviderId)}
        title="删除供应商"
        message="确定要删除这个 AI 供应商吗？保存的 API Key 也会一并删除。"
        confirmText="删除"
        onConfirm={() => void handleDeleteProvider()}
        onCancel={() => setConfirmProviderId(null)}
      />
    </div>
  );
}
