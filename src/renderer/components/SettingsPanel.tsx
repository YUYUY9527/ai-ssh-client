import { useEffect, useState } from 'react';
import { X, Terminal, Wifi, Shield, Bell, Bot, KeyRound, Globe } from 'lucide-react';
import { AIProviderSettings } from './AIProviderSettings';
import { useI18n, useI18nStore, localeNames } from '../i18n';
import type { Locale } from '../i18n';
import type { AppSettings } from '../../shared/types';

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
}

type SettingsTab = 'terminal' | 'ssh' | 'providers' | 'security' | 'notifications' | 'agent' | 'language';

interface ToggleButtonProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

function ToggleButton({ enabled, onChange }: ToggleButtonProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
        enabled
          ? 'border-teal-500 bg-teal-600'
          : 'border-slate-300 bg-slate-200 dark:border-slate-600 dark:bg-slate-700'
      }`}
    >
      <span
        className={`pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function SettingsPanel({ settings, onSave, onClose, initialTab = 'terminal' }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [localSettings, setLocalSettings] = useState<AppSettings>({
    ...settings,
    // 安全设置
    approveHighRisk: settings.approveHighRisk ?? true,
    approveMediumRisk: settings.approveMediumRisk ?? true,
    rememberChoice: settings.rememberChoice ?? true,
    // 通知设置
    connectionNotifications: settings.connectionNotifications ?? true,
    commandNotifications: settings.commandNotifications ?? false,
  });

  const handleSave = () => {
    onSave(localSettings);
    onClose();
  };

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const { t } = useI18n();

  const tabs = [
    { id: 'terminal', label: t('settings.tabs.terminal'), icon: Terminal },
    { id: 'ssh', label: t('settings.tabs.ssh'), icon: Wifi },
    { id: 'providers', label: t('settings.tabs.providers'), icon: KeyRound },
    { id: 'agent', label: t('settings.tabs.agent'), icon: Bot },
    { id: 'security', label: t('settings.tabs.security'), icon: Shield },
    { id: 'notifications', label: t('settings.tabs.notifications'), icon: Bell },
    { id: 'language', label: t('settings.tabs.language'), icon: Globe },
  ] as const;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="industrial-modal w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="industrial-modal-header">
          <h2 className="font-semibold text-slate-900 dark:text-white">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className="icon-button"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className="w-48 border-r border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_54%,var(--bg-secondary))] p-2 overflow-y-auto scrollbar-thin">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-sm border text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'border-teal-500 bg-teal-600 text-white'
                    : 'border-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Settings Content */}
          <div className="flex-1 p-6 overflow-y-auto scrollbar-modern">
            {activeTab === 'terminal' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.terminal.title')}</h3>

                {/* 字体大小 */}
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
                      onChange={(e) => setLocalSettings({ ...localSettings, fontSize: parseInt(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="text-sm text-slate-600 dark:text-slate-400 w-12">
                      {localSettings.fontSize}px
                    </span>
                  </div>
                </div>

                {/* 字体 */}
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
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.ssh.title')}</h3>

                {/* Keepalive 间隔 */}
                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    {t('settings.ssh.keepaliveInterval')}
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="300"
                    value={localSettings.keepaliveInterval}
                    onChange={(e) => setLocalSettings({ ...localSettings, keepaliveInterval: parseInt(e.target.value) || 0 })}
                    className="industrial-input w-full"
                  />
                  <p className="text-xs text-slate-500 mt-1">{t('settings.ssh.keepaliveDisableHint')}</p>
                </div>

                {/* 最大 Keepalive 次数 */}
                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    {t('settings.ssh.keepaliveCountMax')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={localSettings.keepaliveCountMax}
                    onChange={(e) => setLocalSettings({ ...localSettings, keepaliveCountMax: parseInt(e.target.value) || 3 })}
                    className="industrial-input w-full"
                  />
                </div>

                {/* 自动重连 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.ssh.autoReconnect')}</label>
                    <p className="text-xs text-slate-500">{t('settings.ssh.autoReconnectDesc')}</p>
                  </div>
                  <ToggleButton
                    enabled={localSettings.autoReconnect}
                    onChange={(value) => setLocalSettings({ ...localSettings, autoReconnect: value })}
                  />
                </div>

                {/* 最大重连次数 */}
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
                      onChange={(e) => setLocalSettings({ ...localSettings, maxReconnectAttempts: parseInt(e.target.value) || 5 })}
                    className="industrial-input w-full"
                    />
                  </div>
                )}
              </div>
            )}

            {activeTab === 'agent' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.agent.title')}</h3>

                <div className="industrial-card border-teal-500/50 bg-teal-500/10 p-4">
                  <p className="text-sm text-teal-700 dark:text-teal-300">
                    {t('settings.agent.description')}
                  </p>
                </div>

                {/* 执行控制 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">{t('settings.agent.executionControl')}</h4>

                  <div className="space-y-4">
                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.enableAgent')}</label>
                        <p className="text-xs text-slate-500">{t('settings.agent.autoExecuteDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.agentEnabled ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, agentEnabled: value })}
                      />
                    </div>

                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.autoExecute')}</label>
                        <p className="text-xs text-slate-500">{t('settings.agent.autoExecuteDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.agentAutoExecute ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, agentAutoExecute: value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.maxSteps')}</label>
                      <p className="text-xs text-slate-500 mb-2">{t('settings.agent.maxStepsDesc')}</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxExecutionSteps ?? 20;
                            if (current > 1) {
                              setLocalSettings({ ...localSettings, agentMaxExecutionSteps: current - 1 });
                            }
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={localSettings.agentMaxExecutionSteps ?? 20}
                          onChange={(e) => {
                            const value = parseInt(e.target.value);
                            if (!isNaN(value) && value >= 1) {
                              setLocalSettings({ ...localSettings, agentMaxExecutionSteps: value });
                            }
                          }}
                          min={1}
                          max={100}
                          className="industrial-input w-20 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxExecutionSteps ?? 20;
                            if (current < 100) {
                              setLocalSettings({ ...localSettings, agentMaxExecutionSteps: current + 1 });
                            }
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 上下文管理 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">{t('settings.agent.contextManagement')}</h4>

                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.maxContextMessages')}</label>
                      <p className="text-xs text-slate-500 mb-2">{t('settings.agent.maxContextMessagesDesc')}</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxContextMessages ?? 20;
                            if (current > 5) {
                              setLocalSettings({ ...localSettings, agentMaxContextMessages: current - 1 });
                            }
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={localSettings.agentMaxContextMessages ?? 20}
                          onChange={(e) => {
                            const value = parseInt(e.target.value);
                            if (!isNaN(value) && value >= 5) {
                              setLocalSettings({ ...localSettings, agentMaxContextMessages: value });
                            }
                          }}
                          min={5}
                          max={100}
                          className="industrial-input w-20 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxContextMessages ?? 20;
                            if (current < 100) {
                              setLocalSettings({ ...localSettings, agentMaxContextMessages: current + 1 });
                            }
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.maxTerminalOutput')}</label>
                      <p className="text-xs text-slate-500 mb-2">{t('settings.agent.maxTerminalOutputDesc')}</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxTerminalOutputLength ?? 8000;
                            const newValue = current === 0 ? 0 : Math.max(0, current - 1000);
                            setLocalSettings({ ...localSettings, agentMaxTerminalOutputLength: newValue });
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={localSettings.agentMaxTerminalOutputLength ?? 8000}
                          onChange={(e) => {
                            const value = parseInt(e.target.value);
                            // 允许设置为 0 或任何有效正数
                            if (!isNaN(value) && value >= 0) {
                              setLocalSettings({ ...localSettings, agentMaxTerminalOutputLength: value });
                            }
                          }}
                          min={0}
                          max={50000}
                          step={1000}
                          className="industrial-input w-24 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxTerminalOutputLength ?? 8000;
                            const newValue = Math.min(50000, current + 1000);
                            setLocalSettings({ ...localSettings, agentMaxTerminalOutputLength: newValue });
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.autoTrimContext')}</label>
                        <p className="text-xs text-slate-500">{t('settings.agent.autoTrimContextDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.agentTrimContextEnabled ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, agentTrimContextEnabled: value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.agent.taskContextRounds')}</label>
                      <p className="text-xs text-slate-500 mb-2">{t('settings.agent.taskContextRoundsDesc')}</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentTaskContextRounds ?? 3;
                            if (current > 0) {
                              setLocalSettings({ ...localSettings, agentTaskContextRounds: current - 1 });
                            }
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={localSettings.agentTaskContextRounds ?? 3}
                          onChange={(e) => {
                            const value = parseInt(e.target.value);
                            if (!isNaN(value) && value >= 0) {
                              setLocalSettings({ ...localSettings, agentTaskContextRounds: value });
                            }
                          }}
                          min={0}
                          max={10}
                          className="industrial-input w-20 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentTaskContextRounds ?? 3;
                            if (current < 10) {
                              setLocalSettings({ ...localSettings, agentTaskContextRounds: current + 1 });
                            }
                          }}
                          className="industrial-button-secondary h-8 w-8 px-0 py-0"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'providers' && (
              <AIProviderSettings />
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.security.title')}</h3>

                <div className="industrial-card border-yellow-500/50 bg-yellow-500/10 p-4">
                  <p className="text-sm text-yellow-600 dark:text-yellow-400">
                    {t('settings.security.storageWarning')}
                  </p>
                </div>

                {/* 命令审批 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">{t('settings.security.commandApproval')}</h4>

                  <div className="space-y-4">
                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.security.approveHighRisk')}</label>
                        <p className="text-xs text-slate-500">{t('settings.security.approveHighRiskDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.approveHighRisk ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, approveHighRisk: value })}
                      />
                    </div>

                    <div className="industrial-setting-row">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.security.approveMediumRisk')}</label>
                        <p className="text-xs text-slate-500">{t('settings.security.approveMediumRiskDesc')}</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.approveMediumRisk ?? false}
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
                        onChange={(value) => setLocalSettings({ ...localSettings, rememberChoice: value })}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">{t('settings.notifications.title')}</h3>

                <div className="space-y-4">
                  <div className="industrial-setting-row">
                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.notifications.connectionNotifications')}</label>
                      <p className="text-xs text-slate-500">{t('settings.notifications.connectionNotificationsDesc')}</p>
                    </div>
                    <ToggleButton
                      enabled={localSettings.connectionNotifications ?? true}
                      onChange={(value) => setLocalSettings({ ...localSettings, connectionNotifications: value })}
                    />
                  </div>

                  <div className="industrial-setting-row">
                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">{t('settings.notifications.commandNotifications')}</label>
                      <p className="text-xs text-slate-500">{t('settings.notifications.commandNotificationsDesc')}</p>
                    </div>
                    <ToggleButton
                      enabled={localSettings.commandNotifications ?? false}
                      onChange={(value) => setLocalSettings({ ...localSettings, commandNotifications: value })}
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'language' && (
              <div className="space-y-6">
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
                        onClick={() => {
                          setLocalSettings({ ...localSettings, language: locale });
                          useI18nStore.getState().setLocale(locale);
                        }}
                        className={`flex items-center gap-3 px-4 py-3 rounded-sm border text-sm transition-colors ${
                          localSettings.language === locale
                            ? 'border-teal-500 bg-teal-600/10 text-teal-600 dark:text-teal-400'
                            : 'border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                        }`}
                      >
                        <Globe className="w-4 h-4" />
                        <span className="font-medium">{name}</span>
                        {localSettings.language === locale && (
                          <span className="ml-auto text-xs text-teal-500">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="industrial-modal-footer">
          <button
            onClick={onClose}
            className="industrial-button-secondary"
          >
            {t('common.cancel')}
          </button>
          <button
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
