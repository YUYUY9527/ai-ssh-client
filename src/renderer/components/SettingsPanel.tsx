import { useEffect, useState } from 'react';
import { Check, Shield, Trash2, X, Terminal, Wifi, Bot, KeyRound, Globe, Lock, Server } from 'lucide-react';
import { AIProviderSettings } from './AIProviderSettings';
import { McpSettings } from './McpSettings';
import { clearRememberedRiskDecisions } from '../assistant/risk-approval-memory';
import { useI18n, useI18nStore, localeNames } from '../i18n';
import type { Locale } from '../i18n';
import type { AppSettings, HostTrustRecord } from '../../shared/types';
import {
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  clampTerminalScrollback,
  normalizeCursorStyle,
  resolveTerminalRuntimeSettings,
} from '../session/terminal/terminal-settings';
import { IndustrialSelect } from '../shared-ui/IndustrialSelect';
import { SettingsItem, SettingsPage, SettingsSection, ToggleSwitch } from '../settings/SettingsLayout';

const FONT_FAMILY_OPTIONS = [
  { value: "Consolas, 'Courier New', monospace", label: 'Consolas' },
  { value: "'Cascadia Code', Consolas, monospace", label: 'Cascadia Code' },
  { value: "'Fira Code', Consolas, monospace", label: 'Fira Code' },
  { value: "'JetBrains Mono', Consolas, monospace", label: 'JetBrains Mono' },
  { value: "'Source Code Pro', Consolas, monospace", label: 'Source Code Pro' },
  { value: "'Courier New', monospace", label: 'Courier New' },
  { value: 'monospace', label: 'System Monospace' },
];

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
  /** Web 部署下修改密码成功后回调，用于隐藏默认密码横幅。 */
  onPasswordChanged?: () => void;
}

type SettingsTab = 'terminal' | 'ssh' | 'providers' | 'agent' | 'mcp' | 'language' | 'password';

// Web 部署下才提供修改登录密码入口（桌面端无 Web 登录概念）。
const IS_WEB = typeof window !== 'undefined' && window.__AISSH_WEB__ === true;

export function SettingsPanel({ settings, onSave, onClose, initialTab = 'terminal', onPasswordChanged }: SettingsPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  // 修改密码表单状态（仅 Web 部署使用）。
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [localSettings, setLocalSettings] = useState<AppSettings>({
    ...settings,
    approveHighRisk: settings.approveHighRisk ?? true,
    approveMediumRisk: settings.approveMediumRisk ?? true,
    rememberChoice: settings.rememberChoice ?? true,
  });
  const [hostTrustRecords, setHostTrustRecords] = useState<HostTrustRecord[]>([]);
  const [hostTrustLoading, setHostTrustLoading] = useState(false);
  const [hostTrustError, setHostTrustError] = useState<string | null>(null);

  const handleSave = () => {
    const terminalRuntime = resolveTerminalRuntimeSettings(localSettings);
    onSave({
      ...localSettings,
      terminalScrollback: terminalRuntime.scrollback,
      terminalCursorStyle: terminalRuntime.cursorStyle,
      terminalCursorBlink: terminalRuntime.cursorBlink,
      terminalCopyOnSelect: terminalRuntime.copyOnSelect,
      terminalShellIntegration: terminalRuntime.shellIntegration,
      agentSemanticSummaryContextLength: Math.max(
        1000,
        Math.floor(localSettings.agentSemanticSummaryContextLength ?? 12000),
      ),
    });
    onClose();
  };

  const handleChangePassword = async () => {
    setPwError(null);
    setPwSuccess(false);
    if (!pwCurrent || !pwNew || !pwConfirm) {
      setPwError(t('settings.password.errorRequired'));
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError(t('settings.password.errorMismatch'));
      return;
    }
    if (pwNew.length < 4) {
      setPwError(t('settings.password.errorTooShort'));
      return;
    }
    if (pwNew === pwCurrent) {
      setPwError(t('settings.password.errorSame'));
      return;
    }
    if (!window.electronAPI?.webChangePassword) {
      setPwError(t('settings.password.errorGeneric'));
      return;
    }
    setPwSubmitting(true);
    try {
      const result = await window.electronAPI.webChangePassword(pwCurrent, pwNew);
      if (result.success) {
        setPwSuccess(true);
        setPwCurrent('');
        setPwNew('');
        setPwConfirm('');
        onPasswordChanged?.();
      } else if (result.code === 'BAD_OLD_PASSWORD') {
        setPwError(t('settings.password.errorBadCurrent'));
      } else if (result.code === 'ENV_MANAGED') {
        setPwError(t('settings.password.errorManaged'));
      } else if (result.code === 'WEAK_PASSWORD') {
        setPwError(t('settings.password.errorTooShort'));
      } else {
        setPwError(result.error || t('settings.password.errorGeneric'));
      }
    } catch {
      setPwError(t('settings.password.errorGeneric'));
    } finally {
      setPwSubmitting(false);
    }
  };

  const terminalRuntimePreview = resolveTerminalRuntimeSettings(localSettings);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const loadHostTrustRecords = async () => {
    if (!window.electronAPI?.sshListHostTrustRecords) {
      setHostTrustRecords([]);
      return;
    }
    setHostTrustLoading(true);
    setHostTrustError(null);
    try {
      const result = await window.electronAPI.sshListHostTrustRecords();
      if (result.success) {
        setHostTrustRecords(Array.isArray(result.data?.records) ? result.data.records : []);
      } else {
        setHostTrustError(result.error || t('settings.ssh.trustLoadFailed'));
      }
    } catch (error) {
      setHostTrustError((error as Error).message);
    } finally {
      setHostTrustLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'ssh') {
      void loadHostTrustRecords();
    }
  }, [activeTab]);

  const handleDeleteHostTrust = async (record: HostTrustRecord) => {
    if (!window.electronAPI?.sshDeleteHostTrustRecord) {
      return;
    }
    const result = await window.electronAPI.sshDeleteHostTrustRecord(record.host, record.port);
    if (result.success) {
      setHostTrustRecords((prev) => prev.filter((item) => !(
        item.host === record.host && item.port === record.port
      )));
    } else {
      setHostTrustError(result.error || t('settings.ssh.trustDeleteFailed'));
    }
  };

  const handleClearHostTrust = async () => {
    if (!window.electronAPI?.sshClearHostTrustRecords) {
      return;
    }
    const result = await window.electronAPI.sshClearHostTrustRecords();
    if (result.success) {
      setHostTrustRecords([]);
    } else {
      setHostTrustError(result.error || t('settings.ssh.trustClearFailed'));
    }
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Terminal }> = [
    { id: 'terminal', label: t('settings.tabs.terminal'), icon: Terminal },
    { id: 'ssh', label: t('settings.tabs.ssh'), icon: Wifi },
    { id: 'providers', label: t('settings.tabs.providers'), icon: KeyRound },
    { id: 'agent', label: t('settings.tabs.agent'), icon: Bot },
    { id: 'language', label: t('settings.tabs.language'), icon: Globe },
    // MCP 只存在于 Web 部署，桌面端不展示对应配置页。
    ...(IS_WEB ? [{ id: 'mcp' as SettingsTab, label: t('settings.tabs.mcp'), icon: Server }] : []),
    // 仅 Web 部署提供修改登录密码。
    ...(IS_WEB ? [{ id: 'password' as SettingsTab, label: t('settings.tabs.password'), icon: Lock }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="industrial-modal relative z-10 flex max-h-[84vh] w-full max-w-3xl flex-col overflow-hidden">
        <div className="industrial-modal-header">
          <h2 className="font-semibold text-slate-900 dark:text-white">{t('settings.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="icon-button"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
          <div className="scrollbar-thin flex w-full shrink-0 gap-1 overflow-x-auto border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_54%,var(--bg-secondary))] p-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-pressed={activeTab === tab.id}
                className={`settings-nav-item ${
                  activeTab === tab.id ? 'settings-nav-item-active' : ''
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          <div className="scrollbar-modern min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {activeTab === 'terminal' && (
              <SettingsPage title={t('settings.terminal.title')}>
                <SettingsSection title={t('settings.terminal.appearance')}>
                  <SettingsItem label={t('settings.terminal.fontSize')} layout="block">
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="10"
                        max="24"
                        value={localSettings.fontSize}
                        onChange={(e) => setLocalSettings({ ...localSettings, fontSize: parseInt(e.target.value, 10) })}
                        className="settings-range flex-1"
                        aria-label={t('settings.terminal.fontSize')}
                      />
                      <span className="w-12 shrink-0 text-right text-sm tabular-nums text-slate-600 dark:text-slate-300">
                        {localSettings.fontSize}px
                      </span>
                    </div>
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.terminal.fontFamily')}
                    controlClassName="w-full sm:w-56"
                  >
                    <IndustrialSelect
                      value={localSettings.fontFamily}
                      options={FONT_FAMILY_OPTIONS}
                      onChange={(value) => setLocalSettings({ ...localSettings, fontFamily: value })}
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.terminal.cursorStyle')}
                    controlClassName="w-full sm:w-44"
                  >
                    <IndustrialSelect
                      value={terminalRuntimePreview.cursorStyle}
                      options={[
                        { value: 'block', label: t('terminal.cursorBlock') },
                        { value: 'underline', label: t('terminal.cursorUnderline') },
                        { value: 'bar', label: t('terminal.cursorBar') },
                      ]}
                      onChange={(value) => setLocalSettings({
                        ...localSettings,
                        terminalCursorStyle: normalizeCursorStyle(value),
                      })}
                    />
                  </SettingsItem>

                  <SettingsItem label={t('settings.terminal.cursorBlink')}>
                    <ToggleSwitch
                      enabled={terminalRuntimePreview.cursorBlink}
                      label={t('settings.terminal.cursorBlink')}
                      onChange={(value) => setLocalSettings({ ...localSettings, terminalCursorBlink: value })}
                    />
                  </SettingsItem>
                </SettingsSection>

                <SettingsSection title={t('settings.terminal.behavior')}>
                  <SettingsItem
                    label={t('settings.terminal.scrollback')}
                    description={t('settings.terminal.scrollbackDesc')}
                    layout="block"
                  >
                    <input
                      type="number"
                      min={MIN_TERMINAL_SCROLLBACK}
                      max={MAX_TERMINAL_SCROLLBACK}
                      value={terminalRuntimePreview.scrollback}
                      onChange={(e) => setLocalSettings({
                        ...localSettings,
                        terminalScrollback: clampTerminalScrollback(parseInt(e.target.value, 10)),
                      })}
                      className="industrial-input w-36"
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.terminal.copyOnSelect')}
                    description={t('settings.terminal.copyOnSelectDesc')}
                  >
                    <ToggleSwitch
                      enabled={terminalRuntimePreview.copyOnSelect}
                      label={t('settings.terminal.copyOnSelect')}
                      onChange={(value) => setLocalSettings({ ...localSettings, terminalCopyOnSelect: value })}
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.terminal.shellIntegration')}
                    description={t('settings.terminal.shellIntegrationDesc')}
                  >
                    <ToggleSwitch
                      enabled={terminalRuntimePreview.shellIntegration}
                      label={t('settings.terminal.shellIntegration')}
                      onChange={(value) => setLocalSettings({ ...localSettings, terminalShellIntegration: value })}
                    />
                  </SettingsItem>
                </SettingsSection>
              </SettingsPage>
            )}

            {activeTab === 'ssh' && (
              <SettingsPage title={t('settings.ssh.title')}>
                <SettingsSection title={t('settings.ssh.connection')}>
                  <SettingsItem
                    label={t('settings.ssh.keepaliveInterval')}
                    description={t('settings.ssh.keepaliveDisableHint')}
                    controlClassName="w-full sm:w-32"
                  >
                    <input
                      type="number"
                      min="0"
                      max="300"
                      value={localSettings.keepaliveInterval}
                      onChange={(e) => setLocalSettings({ ...localSettings, keepaliveInterval: parseInt(e.target.value, 10) || 0 })}
                      className="industrial-input w-full"
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.ssh.keepaliveCountMax')}
                    controlClassName="w-full sm:w-32"
                  >
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={localSettings.keepaliveCountMax}
                      onChange={(e) => setLocalSettings({ ...localSettings, keepaliveCountMax: parseInt(e.target.value, 10) || 3 })}
                      className="industrial-input w-full"
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.ssh.autoReconnect')}
                    description={t('settings.ssh.autoReconnectDesc')}
                  >
                    <ToggleSwitch
                      enabled={localSettings.autoReconnect}
                      label={t('settings.ssh.autoReconnect')}
                      onChange={(value) => setLocalSettings({ ...localSettings, autoReconnect: value })}
                    />
                  </SettingsItem>

                  {localSettings.autoReconnect && (
                    <SettingsItem
                      label={t('settings.ssh.maxReconnectAttempts')}
                      controlClassName="w-full sm:w-32"
                    >
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={localSettings.maxReconnectAttempts}
                        onChange={(e) => setLocalSettings({ ...localSettings, maxReconnectAttempts: parseInt(e.target.value, 10) || 5 })}
                        className="industrial-input w-full"
                      />
                    </SettingsItem>
                  )}
                </SettingsSection>

                <SettingsSection title={t('settings.ssh.fileManagerSection')}>
                  <SettingsItem
                    label={t('settings.ssh.fileManagerPersistent')}
                    description={t('settings.ssh.fileManagerPersistentDesc')}
                  >
                    <ToggleSwitch
                      enabled={localSettings.fileManagerPersistent ?? false}
                      label={t('settings.ssh.fileManagerPersistent')}
                      onChange={(value) => setLocalSettings({ ...localSettings, fileManagerPersistent: value })}
                    />
                  </SettingsItem>
                </SettingsSection>

                <SettingsSection
                  title={(
                    <span className="flex items-center gap-1.5">
                      <Shield className="h-3.5 w-3.5 text-teal-500" />
                      {t('settings.ssh.trustedHosts')}
                    </span>
                  )}
                  description={t('settings.ssh.trustedHostsDesc')}
                  actions={hostTrustRecords.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => void handleClearHostTrust()}
                      className="industrial-button-secondary px-2.5 py-1.5 text-xs"
                    >
                      {t('settings.ssh.clearTrustedHosts')}
                    </button>
                  ) : undefined}
                >
                  <div className="space-y-2 py-3.5">
                    {hostTrustLoading ? (
                      <div className="py-4 text-center text-sm text-slate-500">
                        {t('common.loading')}
                      </div>
                    ) : hostTrustError ? (
                      <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                        {hostTrustError}
                      </div>
                    ) : hostTrustRecords.length === 0 ? (
                      <div className="rounded-md border border-dashed border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] px-3 py-4 text-center text-sm text-slate-500">
                        {t('settings.ssh.noTrustedHosts')}
                      </div>
                    ) : (
                      hostTrustRecords.map((record) => (
                        <div
                          key={`${record.host}:${record.port}:${record.fingerprint}`}
                          className="industrial-card flex items-start justify-between gap-3 p-3"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
                              {record.host}:{record.port}
                            </div>
                            <div className="mt-1 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                              {record.algorithm} · {record.fingerprint}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-400">
                              {t('settings.ssh.trustedAt')}: {new Date(record.trustedAt).toLocaleString()}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDeleteHostTrust(record)}
                            className="icon-button h-7 w-7 text-danger"
                            title={t('common.delete')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </SettingsSection>
              </SettingsPage>
            )}

            {activeTab === 'agent' && (
              <SettingsPage
                title={t('settings.agent.title')}
                description={t('settings.agent.description')}
              >
                <SettingsSection title={t('settings.agent.executionControl')}>
                  <SettingsItem
                    label={t('settings.agent.enableAgent')}
                    description={t('settings.agent.enableAgentDesc')}
                  >
                    <ToggleSwitch
                      enabled={localSettings.agentEnabled ?? true}
                      label={t('settings.agent.enableAgent')}
                      onChange={(value) => setLocalSettings({ ...localSettings, agentEnabled: value })}
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.agent.readOnlyMode')}
                    description={t('settings.agent.readOnlyModeDesc')}
                  >
                    <ToggleSwitch
                      enabled={localSettings.agentReadOnlyMode ?? false}
                      label={t('settings.agent.readOnlyMode')}
                      onChange={(value) => setLocalSettings({ ...localSettings, agentReadOnlyMode: value })}
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.agent.summaryContextLength')}
                    description={t('settings.agent.summaryContextLengthDesc')}
                    controlClassName="w-full sm:w-36"
                  >
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={localSettings.agentSemanticSummaryContextLength ?? 12000}
                      onChange={(e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value)) {
                          setLocalSettings({
                            ...localSettings,
                            agentSemanticSummaryContextLength: Math.max(1000, value),
                          });
                        }
                      }}
                      className="industrial-input w-full"
                    />
                  </SettingsItem>
                </SettingsSection>

                <SettingsSection title={t('settings.agent.commandApproval')}>
                  <SettingsItem
                    label={t('settings.security.approveHighRisk')}
                    description={t('settings.security.approveHighRiskDesc')}
                  >
                    <ToggleSwitch
                      enabled={localSettings.approveHighRisk ?? true}
                      label={t('settings.security.approveHighRisk')}
                      onChange={(value) => setLocalSettings({ ...localSettings, approveHighRisk: value })}
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.security.approveMediumRisk')}
                    description={t('settings.security.approveMediumRiskDesc')}
                  >
                    <ToggleSwitch
                      enabled={localSettings.approveMediumRisk ?? true}
                      label={t('settings.security.approveMediumRisk')}
                      onChange={(value) => setLocalSettings({ ...localSettings, approveMediumRisk: value })}
                    />
                  </SettingsItem>

                  <SettingsItem
                    label={t('settings.security.rememberChoice')}
                    description={t('settings.security.rememberChoiceDesc')}
                  >
                    <ToggleSwitch
                      enabled={localSettings.rememberChoice ?? true}
                      label={t('settings.security.rememberChoice')}
                      onChange={(value) => {
                        // 关闭后清空会话级记忆，避免残留自动批准
                        if (!value) {
                          clearRememberedRiskDecisions();
                        }
                        setLocalSettings({ ...localSettings, rememberChoice: value });
                      }}
                    />
                  </SettingsItem>
                </SettingsSection>
              </SettingsPage>
            )}

            {activeTab === 'providers' && (
              <AIProviderSettings />
            )}

            {activeTab === 'mcp' && (
              <McpSettings />
            )}

            {activeTab === 'language' && (
              <SettingsPage
                title={t('settings.language.title')}
                description={t('settings.language.selectLanguageDesc')}
              >
                <div className="grid gap-2">
                  {(Object.entries(localeNames) as Array<[Locale, string]>).map(([locale, name]) => {
                    const selected = localSettings.language === locale;
                    return (
                      <button
                        key={locale}
                        type="button"
                        onClick={() => {
                          setLocalSettings({ ...localSettings, language: locale });
                          useI18nStore.getState().setLocale(locale);
                        }}
                        aria-pressed={selected}
                        className={`flex items-center gap-3 rounded-md border px-4 py-3 text-sm transition-colors ${
                          selected
                            ? 'border-[color-mix(in_srgb,var(--accent-primary)_60%,var(--border-color))] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] text-slate-900 dark:text-white'
                            : 'border-[color-mix(in_srgb,var(--border-color)_60%,transparent)] text-slate-600 hover:bg-[color-mix(in_srgb,var(--bg-hover)_60%,transparent)] dark:text-slate-300'
                        }`}
                      >
                        <Globe className="h-4 w-4" />
                        <span className="font-medium">{name}</span>
                        {selected && <Check className="ml-auto h-4 w-4 text-teal-500" />}
                      </button>
                    );
                  })}
                </div>
              </SettingsPage>
            )}

            {activeTab === 'password' && (
              <SettingsPage
                title={t('settings.password.title')}
                description={t('settings.password.description')}
              >
                <div className="max-w-sm space-y-3">
                  <div>
                    <label className="industrial-field-label">{t('settings.password.current')}</label>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={pwCurrent}
                      onChange={(event) => setPwCurrent(event.target.value)}
                      className="industrial-input w-full"
                    />
                  </div>
                  <div>
                    <label className="industrial-field-label">{t('settings.password.new')}</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={pwNew}
                      onChange={(event) => setPwNew(event.target.value)}
                      className="industrial-input w-full"
                    />
                  </div>
                  <div>
                    <label className="industrial-field-label">{t('settings.password.confirm')}</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={pwConfirm}
                      onChange={(event) => setPwConfirm(event.target.value)}
                      className="industrial-input w-full"
                    />
                  </div>

                  {pwError && <p className="text-xs text-red-500">{pwError}</p>}
                  {pwSuccess && <p className="text-xs text-teal-500">{t('settings.password.success')}</p>}

                  <button
                    type="button"
                    onClick={handleChangePassword}
                    disabled={pwSubmitting}
                    className="industrial-button-primary"
                  >
                    {pwSubmitting ? t('settings.password.submitting') : t('settings.password.submit')}
                  </button>
                </div>
              </SettingsPage>
            )}
          </div>
        </div>

        <div className="industrial-modal-footer shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="industrial-button-secondary"
          >
            {t('common.cancel')}
          </button>
          {activeTab !== 'mcp' && activeTab !== 'password' && (
            <button
              type="button"
              onClick={handleSave}
              className="industrial-button-primary"
            >
              {t('common.save')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
