import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Save, Server } from 'lucide-react';

import type {
  McpConfigSnapshot,
  McpPolicyConfig,
  McpPolicyConnection,
  McpPolicyMode,
} from '../../shared/types';
import { useI18n } from '../i18n';
import { IndustrialSelect } from '../shared-ui/IndustrialSelect';
import { SettingsItem, SettingsPage, SettingsSection, ToggleSwitch } from '../settings/SettingsLayout';

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/** 允许中途清空输入，同时保证保存前拿到的始终是有效整数。 */
function NumberField({ value, min, max, onChange }: NumberFieldProps) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = Number(next);
        if (Number.isInteger(parsed)) {
          onChange(parsed);
        }
      }}
      onBlur={() => {
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
          setText(String(value));
        }
      }}
      className="industrial-input w-full"
    />
  );
}

function linesOf(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * MCP 服务端策略设置。
 *
 * 只改 `data/mcp-policy.json`，不碰 app 设置；保存后需要重启 MCP 进程才生效。
 * 页面本身不提供「关闭内置黑名单」的开关，例外只能是精确命令。
 */
export function McpSettings() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<McpPolicyConfig | null>(null);
  const [exceptionsText, setExceptionsText] = useState('');
  const [denyText, setDenyText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const applyPolicy = (policy: McpPolicyConfig) => {
    setDraft(policy);
    setExceptionsText(policy.commands.exceptions.join('\n'));
    setDenyText(policy.commands.deny.join('\n'));
  };

  const load = async () => {
    const api = window.electronAPI;
    if (!api?.mcpGetConfig) {
      setError(t('settings.mcp.unavailable'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.mcpGetConfig();
      if (!result.success) {
        setError(result.error || t('settings.mcp.loadFailed'));
        return;
      }
      if (!result.data) {
        setError(t('settings.mcp.loadFailed'));
        return;
      }
      setSnapshot(result.data);
      applyPolicy(result.data.policy);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 只在页面首次挂载时拉取；重载按钮单独处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateLimit = (key: keyof McpPolicyConfig['limits'], value: number) => {
    setDraft((current) => (current
      ? { ...current, limits: { ...current.limits, [key]: value } }
      : current));
  };

  const updateConnectionMode = (connection: McpPolicyConnection, value: string) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const connections = { ...current.connections };
      // 策略文件可能用名称做键；用户在这里改动后统一改写为 id，避免两套键并存。
      const nameKey = Object.keys(connections).find((key) => (
        key !== connection.id
        && connection.name
        && key.toLowerCase() === connection.name.trim().toLowerCase()
      ));
      if (nameKey) {
        delete connections[nameKey];
      }
      if (!value) {
        delete connections[connection.id];
      } else {
        connections[connection.id] = value as McpPolicyMode;
      }
      return { ...current, connections };
    });
  };

  /** 展示时同时识别 id 键与名称键，避免「文件里明明配了、页面却显示跟随默认」。 */
  const connectionMode = (connection: McpPolicyConnection): string => {
    if (!draft) {
      return '';
    }
    if (draft.connections[connection.id]) {
      return draft.connections[connection.id];
    }
    const name = connection.name.trim().toLowerCase();
    const matched = Object.keys(draft.connections).find((key) => (
      key.toLowerCase() === name && name !== ''
    ));
    return matched ? draft.connections[matched] : '';
  };

  const handleSave = async () => {
    const api = window.electronAPI;
    if (!api?.mcpSaveConfig || !draft) {
      setError(t('settings.mcp.unavailable'));
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const policy: McpPolicyConfig = {
        ...draft,
        commands: {
          deny: linesOf(denyText),
          exceptions: linesOf(exceptionsText),
        },
      };
      const result = await api.mcpSaveConfig(policy);
      if (!result.success) {
        setError(result.error || t('settings.mcp.saveFailed'));
        return;
      }
      if (!result.data) {
        setError(t('settings.mcp.saveFailed'));
        return;
      }
      setSnapshot((current) => (current
        ? { ...current, policy: result.data!.policy, path: result.data!.path, exists: true }
        : current));
      applyPolicy(result.data.policy);
      setSaved(true);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-slate-500">{t('common.loading')}</div>
    );
  }

  if (!draft) {
    return (
      <div className="space-y-3">
        <div className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error || t('settings.mcp.loadFailed')}
        </div>
        <button type="button" onClick={() => void load()} className="industrial-button-secondary">
          <RefreshCw className="h-4 w-4" />
          {t('settings.mcp.retry')}
        </button>
      </div>
    );
  }

  const modeOptions = [
    { value: 'read-only', label: t('settings.mcp.modeReadOnly') },
    { value: 'exec', label: t('settings.mcp.modeExec') },
  ];

  return (
    <SettingsPage
      title={(
        <span className="flex items-center gap-2">
          <Server className="h-4 w-4 text-teal-500" />
          {t('settings.mcp.title')}
        </span>
      )}
      description={t('settings.mcp.description')}
    >

      <div className="industrial-card space-y-1 p-3 text-xs">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium text-slate-700 dark:text-slate-300">
              {t('settings.mcp.policyFile')}
            </div>
            <div className="mt-1 break-all font-mono text-[11px] text-slate-500">
              {snapshot?.path}
            </div>
          </div>
          {snapshot && !snapshot.exists && (
            <span className="shrink-0 rounded-sm bg-amber-500/10 px-2 py-0.5 text-amber-600 dark:text-amber-400">
              {t('settings.mcp.notCreated')}
            </span>
          )}
        </div>
        <p className="text-slate-500">{t('settings.mcp.restartHint')}</p>
      </div>

      {snapshot && snapshot.envOverrides.length > 0 && (
        <div className="flex items-start gap-2 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">{t('settings.mcp.envOverride')}</div>
            <div className="mt-1 font-mono text-[11px]">{snapshot.envOverrides.join(', ')}</div>
            <div className="mt-1">{t('settings.mcp.envOverrideDesc')}</div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {saved && (
        <div className="rounded-sm border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-sm text-teal-600 dark:text-teal-400">
          {t('settings.mcp.saved')}
        </div>
      )}

      <SettingsSection title={t('settings.mcp.general')}>
        <SettingsItem
          label={t('settings.mcp.defaultMode')}
          description={t('settings.mcp.defaultModeDesc')}
          layout="block"
        >
          <IndustrialSelect
            value={draft.defaultMode}
            options={modeOptions}
            onChange={(value) => setDraft({ ...draft, defaultMode: value as McpPolicyMode })}
          />
        </SettingsItem>

        <SettingsItem
          label={t('settings.mcp.trustOnFirstUse')}
          description={t('settings.mcp.trustOnFirstUseDesc')}
        >
          <ToggleSwitch
            enabled={draft.trustOnFirstUse}
            label={t('settings.mcp.trustOnFirstUse')}
            onChange={(value) => setDraft({ ...draft, trustOnFirstUse: value })}
          />
        </SettingsItem>

        <SettingsItem
          label={t('settings.mcp.audit')}
          description={t('settings.mcp.auditDesc')}
        >
          <ToggleSwitch
            enabled={draft.audit.enabled}
            label={t('settings.mcp.audit')}
            onChange={(value) => setDraft({ ...draft, audit: { enabled: value } })}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection title={t('settings.mcp.limits')} description={t('settings.mcp.limitsDesc')}>
        <div className="grid gap-4 py-3.5 sm:grid-cols-2">
          <div>
            <label className="industrial-field-label">{t('settings.mcp.limitOutput')}</label>
            <NumberField
              value={draft.limits.maxOutputBytes}
              min={1024}
              max={4 * 1024 * 1024}
              onChange={(value) => updateLimit('maxOutputBytes', value)}
            />
          </div>
          <div>
            <label className="industrial-field-label">{t('settings.mcp.limitTimeout')}</label>
            <NumberField
              value={draft.limits.execTimeoutMs}
              min={1000}
              max={300000}
              onChange={(value) => updateLimit('execTimeoutMs', value)}
            />
          </div>
          <div>
            <label className="industrial-field-label">{t('settings.mcp.limitCommandChars')}</label>
            <NumberField
              value={draft.limits.maxCommandChars}
              min={128}
              max={65536}
              onChange={(value) => updateLimit('maxCommandChars', value)}
            />
          </div>
          <div>
            <label className="industrial-field-label">{t('settings.mcp.limitReadBytes')}</label>
            <NumberField
              value={draft.limits.maxReadBytes}
              min={1024}
              max={1024 * 1024}
              onChange={(value) => updateLimit('maxReadBytes', value)}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.mcp.connections')}
        description={t('settings.mcp.connectionsDesc')}
      >
        <div className="max-h-72 space-y-2 overflow-y-auto py-3.5 pr-1">
          {snapshot?.connections.length === 0 && (
            <div className="rounded-md border border-dashed border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] px-3 py-3 text-center text-xs text-slate-500">
              {t('settings.mcp.noConnections')}
            </div>
          )}
          {snapshot?.connections.map((connection) => (
            <div
              key={connection.id}
              className="industrial-card flex items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
                  {connection.name || connection.host}
                </div>
                <div className="truncate font-mono text-[11px] text-slate-500">
                  {connection.username}@{connection.host}:{connection.port}
                </div>
              </div>
              <div className="w-36 shrink-0">
                <IndustrialSelect
                  value={connectionMode(connection)}
                  options={[
                    { value: '', label: t('settings.mcp.modeInherit') },
                    ...modeOptions,
                  ]}
                  onChange={(value) => updateConnectionMode(connection, value)}
                />
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.mcp.exceptions')}
        description={t('settings.mcp.exceptionsDesc')}
      >
        <div className="py-3.5">
          <textarea
            value={exceptionsText}
            onChange={(event) => setExceptionsText(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={t('settings.mcp.exceptionsPlaceholder')}
            className="industrial-input w-full font-mono text-xs"
          />
        </div>
      </SettingsSection>

      <details className="rounded-md border border-[color-mix(in_srgb,var(--border-color)_60%,transparent)] px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-slate-900 dark:text-white">
          {t('settings.mcp.denyRules')}
        </summary>
        <p className="mt-2 text-xs text-slate-500">{t('settings.mcp.denyRulesDesc')}</p>
        <textarea
          value={denyText}
          onChange={(event) => setDenyText(event.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={t('settings.mcp.denyRulesPlaceholder')}
          className="industrial-input mt-2 w-full font-mono text-xs"
        />
      </details>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="industrial-button-primary"
        >
          <Save className="h-4 w-4" />
          {saving ? t('settings.mcp.saving') : t('settings.mcp.save')}
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="industrial-button-secondary"
          disabled={saving}
        >
          <RefreshCw className="h-4 w-4" />
          {t('settings.mcp.reload')}
        </button>
      </div>
    </SettingsPage>
  );
}