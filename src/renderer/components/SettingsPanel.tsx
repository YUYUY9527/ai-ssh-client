import { useEffect, useState } from 'react';
import { Check, Shield, Trash2, X, Terminal, Wifi, Bot, KeyRound, Globe } from 'lucide-react';
import { AIProviderSettings } from './AIProviderSettings';
import { clearRememberedRiskDecisions } from '../assistant/risk-approval-memory';
import { useI18n, useI18nStore, localeNames } from '../i18n';
import type { Locale } from '../i18n';
import type { AppSettings, HostTrustRecord } from '../../shared/types';

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
}

type SettingsTab = 'terminal' | 'ssh' | 'providers' | 'agent' | 'language';

interface ToggleButtonProps {
  enabled: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
}

function ToggleButton({ enabled, label, onChange }: ToggleButtonProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className={`ui-toggle ${enabled ? 'ui-toggle-on' : 'ui-toggle-off'}`}
    >
      <span className="ui-toggle-thumb" />
    </button>
  );
}

export function SettingsPanel({ settings, onSave, onClose, initialTab = 'terminal' }: SettingsPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
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
    onSave({
      ...localSettings,
      agentSemanticSummaryContextLength: Math.max(
        1000,
        Math.floor(localSettings.agentSemanticSummaryContextLength ?? 12000),
      ),
    });
    onClose();
  };

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

  const tabs = [
    { id: 'terminal', label: t('settings.tabs.terminal'), icon: Terminal },
    { id: 'ssh', label: t('settings.tabs.ssh'), icon: Wifi },
    { id: 'providers', label: t('settings.tabs.providers'), icon: KeyRound },
    { id: 'agent', label: t('settings.tabs.agent'), icon: Bot },
    { id: 'language', label: t('settings.tabs.language'), icon: Globe },
  ] as const;

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

          <div className="scrollbar-modern min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {activeTab === 'terminal' && (
              <div className="space-y-5">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.terminal.title')}</h3>

                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    {t('settings.terminal.fontSize')}
                  </label>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min="10"
                      max="24"
                      value={localSettings.fontSize}
                      onChange={(e) => setLocalSettings({ ...localSettings, fontSize: parseInt(e.target.value, 10) })}
                      className="flex-1"
                    />
                    <span className="text-sm text-slate-600 dark:text-slate-400 w-12">
                      {localSettings.fontSize}px
                    </span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    {t('settings.terminal.fontFamily')}
                  </label>
                  <select
                    value={localSettings.fontFamily}
                    onChange={(e) => setLocalSettings({ ...localSettings, fontFamily: e.target.value })}
                    className="industrial-input w-full"
                  >
                    <option value="Consolas, 'Courier New', monospace">Consolas</option>
                    <option value="'Cascadia Code', Consolas, monospace">Cascadia Code</option>
                    <option value="'Fira Code', Consolas, monospace">Fira Code</option>
                    <option value="'JetBrains Mono', Consolas, monospace">JetBrains Mono</option>
                    <option value="'Source Code Pro', Consolas, monospace">Source Code Pro</option>
                    <option value="'Courier New', monospace">Courier New</option>
                    <option value="monospace">System Monospace</option>
                  </select>
                </div>

              </div>
            )}

            {activeTab === 'ssh' && (
              <div className="space-y-5">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.ssh.title')}</h3>

                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    {t('settings.ssh.keepaliveInterval')}
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="300"
                    value={localSettings.keepaliveInterval}
                    onChange={(e) => setLocalSettings({ ...localSettings, keepaliveInterval: parseInt(e.target.value, 10) || 0 })}
                    className="industrial-input w-full"
                  />
                  <p className="text-xs text-slate-500 mt-1">{t('settings.ssh.keepaliveDisableHint')}</p>
                </div>

                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    {t('settings.ssh.keepaliveCountMax')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={localSettings.keepaliveCountMax}
                    onChange={(e) => setLocalSettings({ ...localSettings, keepaliveCountMax: parseInt(e.target.value, 10) || 3 })}
                    className="industrial-input w-full"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.ssh.autoReconnect')}</label>
                    <p className="text-xs text-slate-500">{t('settings.ssh.autoReconnectDesc')}</p>
                  </div>
                  <ToggleButton
                    enabled={localSettings.autoReconnect}
                    label={t('settings.ssh.autoReconnect')}
                    onChange={(value) => setLocalSettings({ ...localSettings, autoReconnect: value })}
                  />
                </div>

                {localSettings.autoReconnect && (
                  <div>
                    <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                      {t('settings.ssh.maxReconnectAttempts')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={localSettings.maxReconnectAttempts}
                      onChange={(e) => setLocalSettings({ ...localSettings, maxReconnectAttempts: parseInt(e.target.value, 10) || 5 })}
                    className="industrial-input w-full"
                    />
                  </div>
                )}

                <div className="border-t border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] pt-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h4 className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-white">
                        <Shield className="h-4 w-4 text-teal-500" />
                        {t('settings.ssh.trustedHosts')}
                      </h4>
                      <p className="mt-1 text-xs text-slate-500">
                        {t('settings.ssh.trustedHostsDesc')}
                      </p>
                    </div>
                    {hostTrustRecords.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleClearHostTrust()}
                        className="industrial-button-secondary px-2.5 py-1.5 text-xs"
                      >
                        {t('settings.ssh.clearTrustedHosts')}
                      </button>
                    )}
                  </div>

                  {hostTrustLoading ? (
                    <div className="py-4 text-center text-sm text-slate-500">
                      {t('common.loading')}
                    </div>
                  ) : hostTrustError ? (
                    <div className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                      {hostTrustError}
                    </div>
                  ) : hostTrustRecords.length === 0 ? (
                    <div className="rounded-sm border border-dashed border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] px-3 py-4 text-center text-sm text-slate-500">
                      {t('settings.ssh.noTrustedHosts')}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {hostTrustRecords.map((record) => (
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
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'agent' && (
              <div className="space-y-5">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.agent.title')}</h3>

                <div className="industrial-card connection-list-row-active p-4">
                  <p className="text-sm text-teal-700 dark:text-teal-300">
                    {t('settings.agent.description')}
                  </p>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">{t('settings.agent.executionControl')}</h4>

                  <div className="space-y-4">
                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.enableAgent')}</label>
                        <p className="text-xs text-slate-500">{t('settings.agent.enableAgentDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.agentEnabled ?? true}
                        label={t('settings.agent.enableAgent')}
                        onChange={(value) => setLocalSettings({ ...localSettings, agentEnabled: value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.summaryContextLength')}</label>
                      <p className="text-xs text-slate-500 mb-2">{t('settings.agent.summaryContextLengthDesc')}</p>
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
                        className="industrial-input w-36"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">{t('settings.agent.commandApproval')}</h4>

                  <div className="space-y-4">
                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.security.approveHighRisk')}</label>
                        <p className="text-xs text-slate-500">{t('settings.security.approveHighRiskDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.approveHighRisk ?? true}
                        label={t('settings.security.approveHighRisk')}
                        onChange={(value) => setLocalSettings({ ...localSettings, approveHighRisk: value })}
                      />
                    </div>

                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.security.approveMediumRisk')}</label>
                        <p className="text-xs text-slate-500">{t('settings.security.approveMediumRiskDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.approveMediumRisk ?? true}
                        label={t('settings.security.approveMediumRisk')}
                        onChange={(value) => setLocalSettings({ ...localSettings, approveMediumRisk: value })}
                      />
                    </div>

                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.security.rememberChoice')}</label>
                        <p className="text-xs text-slate-500">{t('settings.security.rememberChoiceDesc')}</p>
                      </div>
                      <ToggleButton
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
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'providers' && (
              <AIProviderSettings />
            )}

            {activeTab === 'language' && (
              <div className="space-y-5">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.language.title')}</h3>

                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    {t('settings.language.selectLanguage')}
                  </label>
                  <p className="text-xs text-slate-500 mb-3">{t('settings.language.selectLanguageDesc')}</p>
                  <div className="grid gap-2">
                    {(Object.entries(localeNames) as Array<[Locale, string]>).map(([locale, name]) => (
                      <button
                        key={locale}
                        type="button"
                        onClick={() => {
                          setLocalSettings({ ...localSettings, language: locale });
                          useI18nStore.getState().setLocale(locale);
                        }}
                        aria-pressed={localSettings.language === locale}
                        className={`flex items-center gap-3 px-4 py-3 rounded-sm border text-sm transition-colors ${
                          localSettings.language === locale
                            ? 'border-teal-500 bg-teal-600/10 text-teal-600 dark:text-teal-400'
                            : 'border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                        }`}
                      >
                        <Globe className="w-4 h-4" />
                        <span className="font-medium">{name}</span>
                        {localSettings.language === locale && (
                          <Check className="ml-auto h-4 w-4 text-teal-500" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
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
          <button
            type="button"
            onClick={handleSave}
            className="industrial-button-primary"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
