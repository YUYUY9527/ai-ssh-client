import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';

interface AcpAgent {
  name: string;
  command: string;
  args: string[];
}

interface AcpConfig {
  enabled: boolean;
  agents: AcpAgent[];
}

/**
 * 设置页「外部智能体 (ACP)」区块：显式启用 + 管理本机可用的 ACP 智能体命令，
 * 并提供一次握手测试。默认关闭，需要手动打开开关。
 */
export function AcpSettings() {
  const { t } = useI18n();
  const [config, setConfig] = useState<AcpConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const api = window.electronAPI?.getAcpConfig ? window.electronAPI : null;

  const load = useCallback(async () => {
    if (!api) {
      setLoading(false);
      setMessage(t('settings.acp.unavailable'));
      return;
    }
    setLoading(true);
    try {
      const result = await api.getAcpConfig!();
      if (result.success && result.data) {
        setConfig(result.data);
      } else {
        setMessage(result.success ? t('settings.acp.loadFailed') : String(result.error || t('settings.acp.loadFailed')));
      }
    } catch {
      setMessage(t('settings.acp.loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: AcpConfig) => {
    if (!api) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await api.saveAcpConfig!(next);
      if (result.success && result.data) {
        setConfig(result.data);
      } else {
        setMessage(result.success ? t('settings.acp.saveFailed') : String(result.error || t('settings.acp.saveFailed')));
      }
    } catch {
      setMessage(t('settings.acp.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (name: string) => {
    if (!api) return;
    setTesting(name);
    setMessage(null);
    try {
      const result = await api.testAcpAgent!(name);
      setMessage(result.success
        ? t('settings.acp.testOk', { name })
        : String(result.error || t('settings.acp.testFailed')));
    } catch {
      setMessage(t('settings.acp.testFailed'));
    } finally {
      setTesting(null);
    }
  };

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-fg-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('common.loading')}
      </p>
    );
  }

  if (!api) {
    return <p className="text-xs text-fg-muted">{t('settings.acp.unavailable')}</p>;
  }

  const agents = config?.agents ?? [];

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={config?.enabled ?? false}
          onChange={(event) => void save({ enabled: event.target.checked, agents })}
          className="h-4 w-4 accent-accent"
        />
        {t('settings.acp.enabled')}
      </label>
      <p className="text-xs leading-5 text-fg-secondary dark:text-fg-muted">{t('settings.acp.enabledDesc')}</p>

      {agents.length === 0 && (
        <p className="text-xs text-fg-muted">{t('settings.acp.empty')}</p>
      )}

      <div className="space-y-2">
        {agents.map((agent, index) => (
          <div key={`${agent.name}-${index}`} className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface px-2 py-1.5">
            <input
              value={agent.name}
              onChange={(event) => {
                const next = agents.map((item, i) => (i === index ? { ...item, name: event.target.value } : item));
                setConfig({ enabled: config?.enabled ?? false, agents: next });
              }}
              className="industrial-input w-28 text-xs"
              placeholder="name"
            />
            <input
              value={agent.command}
              onChange={(event) => {
                const next = agents.map((item, i) => (i === index ? { ...item, command: event.target.value } : item));
                setConfig({ enabled: config?.enabled ?? false, agents: next });
              }}
              className="industrial-input min-w-0 flex-1 font-mono text-xs"
              placeholder="command"
            />
            <input
              value={agent.args.join(' ')}
              onChange={(event) => {
                const args = event.target.value.split(' ').filter(Boolean);
                const next = agents.map((item, i) => (i === index ? { ...item, args } : item));
                setConfig({ enabled: config?.enabled ?? false, agents: next });
              }}
              className="industrial-input w-40 font-mono text-xs"
              placeholder="--args"
            />
            <button
              type="button"
              onClick={() => void handleTest(agent.name)}
              disabled={testing === agent.name || !(config?.enabled ?? false)}
              className="industrial-button-secondary h-7 px-2 text-xs"
            >
              {testing === agent.name ? <Loader2 className="h-3 w-3 animate-spin" /> : t('settings.acp.test')}
            </button>
            <button
              type="button"
              onClick={() => void save({ enabled: config?.enabled ?? false, agents: agents.filter((_, i) => i !== index) })}
              className="icon-button h-7 w-7 text-danger"
              title={t('common.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save({
            enabled: config?.enabled ?? false,
            agents: [...agents, { name: '', command: '', args: [] }],
          })}
          disabled={agents.length >= 10}
          className="industrial-button-secondary h-7 gap-1 px-2 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('settings.acp.add')}
        </button>
        <button
          type="button"
          onClick={() => void save({ enabled: config?.enabled ?? false, agents })}
          disabled={saving}
          className="industrial-button-primary h-7 px-3 text-xs"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save')}
        </button>
      </div>

      {message && <p className="text-xs text-warning">{message}</p>}
    </div>
  );
}
