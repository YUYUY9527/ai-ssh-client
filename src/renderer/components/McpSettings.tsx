import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, ChevronDown, Copy, Globe, Loader2, RefreshCw, Server, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react';

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
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/** 允许中途清空输入，同时保证保存前拿到的始终是有效整数。 */
function NumberField({ id, label, value, min, max, onChange }: NumberFieldProps) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={1}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = Number(next);
        if (next.trim() && Number.isInteger(parsed)) {
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
 * 只改 `data/mcp-policy.json`，不碰 app 设置；HTTP 即时生效，stdio 需重启进程。
 * 页面本身不提供「关闭内置黑名单」的开关，例外只能是精确命令。
 */
export function McpSettings({ footerContainer }: { footerContainer: HTMLDivElement | null }) {
  const { t } = useI18n();
  const [transport, setTransport] = useState<'stdio' | 'http'>('http');
  const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<McpPolicyConfig | null>(null);
  const [exceptionsText, setExceptionsText] = useState('');
  const [denyText, setDenyText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      // 浏览器可能限制剪贴板权限，保留原按钮状态即可。
    }
  };

  const applyPolicy = (policy: McpPolicyConfig) => {
    setSaved(false);
    setDirty(false);
    setDraft(policy);
    setExceptionsText(policy.commands.exceptions.join('\n'));
    setDenyText(policy.commands.deny.join('\n'));
  };

  const updateDraft = (update: (current: McpPolicyConfig) => McpPolicyConfig) => {
    setSaved(false);
    setDirty(true);
    setError(null);
    setDraft((current) => (current ? update(current) : current));
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
    updateDraft((current) => ({
      ...current,
      limits: { ...current.limits, [key]: value },
    }));
  };

  const updateConnectionMode = (connection: McpPolicyConnection, value: string) => {
    updateDraft((current) => {
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
    if (saving) return;
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
      <div className="py-8 text-center text-sm text-fg-muted">{t('common.loading')}</div>
    );
  }

  if (!draft) {
    return (
      <div className="space-y-3">
        <div className="rounded-sm border border-danger bg-danger-muted px-3 py-2 text-sm text-danger dark:text-danger-fg">
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
          <Server className="h-4 w-4 text-accent" />
          {t('settings.mcp.title')}
        </span>
      )}
      description={t('settings.mcp.description')}
      wide
      actions={(
        <button
          type="button"
          onClick={() => void load()}
          className="icon-button"
          title={t('settings.mcp.reload')}
          aria-label={t('settings.mcp.reload')}
          disabled={saving}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      )}
    >
      <section className="mcp-step">
        <header className="mcp-step-heading">
          <span className="mcp-step-index">01</span>
          <div>
            <h3>{t('settings.mcp.access.title')}</h3>
            <p>{t('settings.mcp.access.chooseMethod')}</p>
          </div>
        </header>

        <div className="mcp-method-tabs" role="group" aria-label={t('settings.mcp.access.title')}>
          <button
            type="button"
            aria-pressed={transport === 'http'}
            className={`mcp-method-tab ${transport === 'http' ? 'is-active' : ''}`}
            onClick={() => setTransport('http')}
          >
            <Globe className="h-4 w-4 shrink-0" />
            <span><strong>{t('settings.mcp.access.httpTitle')}</strong><small>{t('settings.mcp.access.httpTabDesc')}</small></span>
            {transport === 'http' ? <Check className="mcp-method-check h-4 w-4" /> : null}
          </button>
          <button
            type="button"
            aria-pressed={transport === 'stdio'}
            className={`mcp-method-tab ${transport === 'stdio' ? 'is-active' : ''}`}
            onClick={() => setTransport('stdio')}
          >
            <Terminal className="h-4 w-4 shrink-0" />
            <span><strong>{t('settings.mcp.access.stdioTitle')}</strong><small>{t('settings.mcp.access.stdioTabDesc')}</small></span>
            {transport === 'stdio' ? <Check className="mcp-method-check h-4 w-4" /> : null}
          </button>
        </div>

        <div className="mcp-method-content">
          {transport === 'http' ? (
            <>
              <div className="mcp-method-intro">
                <span className="mcp-method-icon is-http"><Globe className="h-4 w-4" /></span>
                <div><h4>{t('settings.mcp.access.httpTitle')}</h4><p>{t('settings.mcp.access.httpDesc')}</p></div>
              </div>
              <div className="mcp-copy-section">
                <div className="mcp-copy-label">{t('settings.mcp.access.httpAddressLabel')}</div>
                <div className="mcp-copy-control">
                  <code>{`${window.location.origin}/mcp`}</code>
                  <button
                    type="button"
                    className="mcp-copy-button"
                    title={t('settings.mcp.access.httpCopy')}
                    aria-label={t('settings.mcp.access.httpCopy')}
                    onClick={() => void copyText('mcp-http', `${window.location.origin}/mcp`)}
                  >
                    {copiedKey === 'mcp-http' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="mcp-auth-note">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <div><strong>{t('settings.mcp.access.httpAuthTitle')}</strong><p>{t('settings.mcp.access.httpAuth')}</p></div>
              </div>
            </>
          ) : (
            <>
              <div className="mcp-method-intro">
                <span className="mcp-method-icon is-stdio"><Terminal className="h-4 w-4" /></span>
                <div><h4>{t('settings.mcp.access.stdioTitle')}</h4><p>{t('settings.mcp.access.stdioDesc')}</p></div>
              </div>
              <div className="mcp-copy-section">
                <div className="mcp-copy-label">{t('settings.mcp.access.stdioCommandLabel')}</div>
                <div className="mcp-copy-control">
                  <code>npm run mcp</code>
                  <button
                    type="button"
                    className="mcp-copy-button"
                    title={t('settings.mcp.access.stdioCopy')}
                    aria-label={t('settings.mcp.access.stdioCopy')}
                    onClick={() => void copyText('mcp-stdio', 'npm run mcp')}
                  >
                    {copiedKey === 'mcp-stdio' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <details className="mcp-inline-details">
                <summary><span>{t('settings.mcp.access.advancedRequirements')}</span><ChevronDown className="h-4 w-4" /></summary>
                <p>{t('settings.mcp.access.stdioEnv')}</p>
              </details>
            </>
          )}
        </div>
      </section>

      {snapshot && snapshot.envOverrides.length > 0 && (
        <div className="mcp-environment-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">{t('settings.mcp.envOverride')}</div>
            <div className="mcp-environment-list">{snapshot.envOverrides.join(', ')}</div>
            <div className="mt-1">{t('settings.mcp.envOverrideDesc')}</div>
          </div>
        </div>
      )}

      <section className="mcp-step">
        <header className="mcp-step-heading">
          <span className="mcp-step-index">02</span>
          <div>
            <h3>{t('settings.mcp.general')}</h3>
            <p>{t('settings.mcp.generalDesc')}</p>
          </div>
        </header>

        <div className={`mcp-policy-summary ${draft.defaultMode === 'read-only' ? 'is-readonly' : 'is-exec'}`}>
          {draft.defaultMode === 'read-only' ? <ShieldCheck className="h-5 w-5 shrink-0" /> : <ShieldAlert className="h-5 w-5 shrink-0" />}
          <div>
            <strong>{draft.defaultMode === 'read-only' ? t('settings.mcp.readOnlySummaryTitle') : t('settings.mcp.execSummaryTitle')}</strong>
            <p>{draft.defaultMode === 'read-only' ? t('settings.mcp.readOnlySummaryDesc') : t('settings.mcp.execSummaryDesc')}</p>
          </div>
        </div>

        <SettingsSection title={t('settings.mcp.permissions')} description={t('settings.mcp.permissionsDesc')}>
          <SettingsItem
            label={t('settings.mcp.defaultMode')}
            description={t('settings.mcp.defaultModeDesc')}
            controlClassName="w-full sm:w-48"
          >
            <IndustrialSelect
              value={draft.defaultMode}
              options={modeOptions}
              onChange={(value) => updateDraft((current) => ({ ...current, defaultMode: value as McpPolicyMode }))}
            />
          </SettingsItem>

          <SettingsItem
            label={t('settings.mcp.trustOnFirstUse')}
            description={t('settings.mcp.trustOnFirstUseDesc')}
          >
            <ToggleSwitch
              enabled={draft.trustOnFirstUse}
              label={t('settings.mcp.trustOnFirstUse')}
              onChange={(value) => updateDraft((current) => ({ ...current, trustOnFirstUse: value }))}
            />
          </SettingsItem>

          <SettingsItem
            label={t('settings.mcp.audit')}
            description={t('settings.mcp.auditDesc')}
          >
            <ToggleSwitch
              enabled={draft.audit.enabled}
              label={t('settings.mcp.audit')}
              onChange={(value) => updateDraft((current) => ({ ...current, audit: { enabled: value } }))}
            />
          </SettingsItem>
        </SettingsSection>

        <SettingsSection
          title={t('settings.mcp.connections')}
          description={t('settings.mcp.connectionsDesc')}
          actions={<span className="mcp-count">{snapshot?.connections.length ?? 0}</span>}
        >
          {snapshot?.connections.length === 0 ? (
            <div className="mcp-empty-state">{t('settings.mcp.noConnections')}</div>
          ) : snapshot?.connections.map((connection) => (
            <div key={connection.id} className="mcp-connection-row">
              <span className="mcp-connection-icon"><Server className="h-4 w-4" /></span>
              <div className="mcp-connection-info">
                <div className="mcp-connection-name">{connection.name || connection.host}</div>
                <div className="mcp-connection-address">{connection.username}@{connection.host}:{connection.port}</div>
              </div>
              <div className="mcp-connection-mode">
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
        </SettingsSection>
      </section>

      <section className="mcp-step">
        <header className="mcp-step-heading">
          <span className="mcp-step-index">03</span>
          <div>
            <h3>{t('settings.mcp.limits')}</h3>
            <p>{t('settings.mcp.limitsDesc')}</p>
          </div>
        </header>
        <div className="mcp-limit-grid">
          <div className="mcp-limit-field">
            <label className="industrial-field-label" htmlFor="mcp-limit-output">{t('settings.mcp.limitOutput')}</label>
            <div className="mcp-number-control">
              <NumberField
                id="mcp-limit-output"
                label={t('settings.mcp.limitOutput')}
                value={Math.max(1, Math.round(draft.limits.maxOutputBytes / 1024))}
                min={1}
                max={4 * 1024}
                onChange={(value) => updateLimit('maxOutputBytes', value * 1024)}
              />
              <span>KB</span>
            </div>
          </div>
          <div className="mcp-limit-field">
            <label className="industrial-field-label" htmlFor="mcp-limit-timeout">{t('settings.mcp.limitTimeout')}</label>
            <div className="mcp-number-control">
              <NumberField
                id="mcp-limit-timeout"
                label={t('settings.mcp.limitTimeout')}
                value={Math.max(1, Math.round(draft.limits.execTimeoutMs / 1000))}
                min={1}
                max={300}
                onChange={(value) => updateLimit('execTimeoutMs', value * 1000)}
              />
              <span>{t('settings.mcp.secondsUnit')}</span>
            </div>
          </div>
          <div className="mcp-limit-field">
            <label className="industrial-field-label" htmlFor="mcp-limit-command">{t('settings.mcp.limitCommandChars')}</label>
            <div className="mcp-number-control">
              <NumberField
                id="mcp-limit-command"
                label={t('settings.mcp.limitCommandChars')}
                value={draft.limits.maxCommandChars}
                min={128}
                max={65536}
                onChange={(value) => updateLimit('maxCommandChars', value)}
              />
              <span>{t('settings.mcp.charactersUnit')}</span>
            </div>
          </div>
          <div className="mcp-limit-field">
            <label className="industrial-field-label" htmlFor="mcp-limit-read">{t('settings.mcp.limitReadBytes')}</label>
            <div className="mcp-number-control">
              <NumberField
                id="mcp-limit-read"
                label={t('settings.mcp.limitReadBytes')}
                value={Math.max(1, Math.round(draft.limits.maxReadBytes / 1024))}
                min={1}
                max={1024}
                onChange={(value) => updateLimit('maxReadBytes', value * 1024)}
              />
              <span>KB</span>
            </div>
          </div>
        </div>
      </section>

      <details className="mcp-advanced-rules">
        <summary>
          <span><strong>{t('settings.mcp.advancedTitle')}</strong><small>{t('settings.mcp.advancedDesc')}</small></span>
          <ChevronDown className="h-4 w-4" />
        </summary>
        <div className="mcp-rule-editor">
          <div className="mcp-rule-heading">
            <strong>{t('settings.mcp.exceptions')}</strong>
            <p>{t('settings.mcp.exceptionsDesc')}</p>
          </div>
          <textarea
            value={exceptionsText}
            onChange={(event) => { setSaved(false); setDirty(true); setError(null); setExceptionsText(event.target.value); }}
            rows={3}
            spellCheck={false}
            placeholder={t('settings.mcp.exceptionsPlaceholder')}
            className="industrial-input w-full font-mono text-xs"
          />
        </div>
        <div className="mcp-rule-editor">
          <div className="mcp-rule-heading">
            <strong>{t('settings.mcp.denyRules')}</strong>
            <p>{t('settings.mcp.denyRulesDesc')}</p>
          </div>
          <textarea
            value={denyText}
            onChange={(event) => { setSaved(false); setDirty(true); setError(null); setDenyText(event.target.value); }}
            rows={3}
            spellCheck={false}
            placeholder={t('settings.mcp.denyRulesPlaceholder')}
            className="industrial-input w-full font-mono text-xs"
          />
        </div>
      </details>

      <details className="mcp-technical-details">
        <summary><span>{t('settings.mcp.technicalDetails')}</span><ChevronDown className="h-4 w-4" /></summary>
        <div className="mcp-technical-content">
          <div className="mcp-policy-path">
            <div>
              <div className="font-medium text-fg-secondary">{t('settings.mcp.policyFile')}</div>
              <div className="mt-1 break-all font-mono text-[11px] text-fg-muted">{snapshot?.path}</div>
            </div>
            {snapshot && !snapshot.exists ? <span>{t('settings.mcp.notCreated')}</span> : null}
          </div>
          <p>{t('settings.mcp.restartHint')}</p>
        </div>
      </details>

      {footerContainer && createPortal(
        <>
          <div
            role={error ? 'alert' : saved ? 'status' : undefined}
            className={`settings-save-feedback ${error ? 'is-error' : saved ? 'is-saved' : ''}`}
          >
            {error || (saved ? t('settings.mcp.saved') : dirty ? t('settings.mcp.unsaved') : t('settings.mcp.saveHint'))}
          </div>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            aria-busy={saving}
            className="industrial-button-primary"
          >
            {saving && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
            {t('common.save')}
          </button>
        </>,
        footerContainer,
      )}
    </SettingsPage>
  );
}
