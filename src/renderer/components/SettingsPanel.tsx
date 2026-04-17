import { useState } from 'react';
import { X, Terminal, Wifi, Shield, Bell, Bot } from 'lucide-react';
import type { AppSettings } from '../../shared/types';

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

interface ToggleButtonProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

function ToggleButton({ enabled, onChange }: ToggleButtonProps) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`relative w-11 h-6 rounded-full transition-colors ${
        enabled ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform shadow ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function SettingsPanel({ settings, onSave, onClose }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'terminal' | 'ssh' | 'security' | 'notifications' | 'agent'>('terminal');
  const [localSettings, setLocalSettings] = useState<AppSettings>({
    ...settings,
    // 安全设置
    approveHighRisk: settings.approveHighRisk ?? true,
    approveMediumRisk: settings.approveMediumRisk ?? false,
    rememberChoice: settings.rememberChoice ?? true,
    // 通知设置
    connectionNotifications: settings.connectionNotifications ?? true,
    commandNotifications: settings.commandNotifications ?? false,
    // 终端设置
    showTerminalOutputPrompt: settings.showTerminalOutputPrompt ?? true,
  });

  const handleSave = () => {
    onSave(localSettings);
    onClose();
  };

  const tabs = [
    { id: 'terminal', label: '终端', icon: Terminal },
    { id: 'ssh', label: 'SSH', icon: Wifi },
    { id: 'agent', label: '智能体', icon: Bot },
    { id: 'security', label: '安全', icon: Shield },
    { id: 'notifications', label: '通知', icon: Bell },
  ] as const;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 dark:text-white">设置</h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className="w-48 border-r border-slate-200 dark:border-slate-700 p-2 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-200 dark:[&::-webkit-scrollbar-thumb]:bg-slate-700 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:hover:bg-slate-300 dark:[&::-webkit-scrollbar-thumb]:hover:bg-slate-600">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-blue-500 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Settings Content */}
          <div className="flex-1 p-6 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-300 dark:[&::-webkit-scrollbar-thumb]:bg-slate-600 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:hover:bg-slate-400 dark:[&::-webkit-scrollbar-thumb]:hover:bg-slate-500">
            {activeTab === 'terminal' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">终端设置</h3>

                {/* 字体大小 */}
                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    字体大小
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
                    字体
                  </label>
                  <select
                    value={localSettings.fontFamily}
                    onChange={(e) => setLocalSettings({ ...localSettings, fontFamily: e.target.value })}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                  >
                    <option value="JetBrains Mono, Source Code Pro, Consolas, monospace">JetBrains Mono</option>
                    <option value="Source Code Pro, Consolas, monospace">Source Code Pro</option>
                    <option value="Consolas, monospace">Consolas</option>
                    <option value="Menlo, Monaco, monospace">Menlo</option>
                    <option value="Ubuntu Mono, monospace">Ubuntu Mono</option>
                  </select>
                </div>

                {/* 自动补全提示窗口 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm text-slate-600 dark:text-slate-400">自动补全提示</label>
                    <p className="text-xs text-slate-500">输入时显示命令自动补全提示窗口</p>
                  </div>
                  <ToggleButton
                    enabled={localSettings.showTerminalOutputPrompt ?? true}
                    onChange={(value) => setLocalSettings({ ...localSettings, showTerminalOutputPrompt: value })}
                  />
                </div>
              </div>
            )}

            {activeTab === 'ssh' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">SSH 设置</h3>

                {/* Keepalive 间隔 */}
                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    Keepalive 间隔（秒）
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="300"
                    value={localSettings.keepaliveInterval}
                    onChange={(e) => setLocalSettings({ ...localSettings, keepaliveInterval: parseInt(e.target.value) || 0 })}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                  />
                  <p className="text-xs text-slate-500 mt-1">设置为 0 表示禁用 Keepalive</p>
                </div>

                {/* 最大 Keepalive 次数 */}
                <div>
                  <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                    最大 Keepalive 失败次数
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={localSettings.keepaliveCountMax}
                    onChange={(e) => setLocalSettings({ ...localSettings, keepaliveCountMax: parseInt(e.target.value) || 3 })}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                  />
                </div>

                {/* 自动重连 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm text-slate-600 dark:text-slate-400">自动重连</label>
                    <p className="text-xs text-slate-500">连接断开时自动尝试重新连接</p>
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
                      最大重连次数
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={localSettings.maxReconnectAttempts}
                      onChange={(e) => setLocalSettings({ ...localSettings, maxReconnectAttempts: parseInt(e.target.value) || 5 })}
                      className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white"
                    />
                  </div>
                )}
              </div>
            )}

            {activeTab === 'agent' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">智能体设置</h3>

                <div className="bg-blue-500/10 border border-blue-500/50 rounded-lg p-4">
                  <p className="text-sm text-blue-600 dark:text-blue-400">
                    AI 智能体可以自动执行命令来完成任务。请谨慎配置安全选项。
                  </p>
                </div>

                {/* 执行控制 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">执行控制</h4>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">启用智能体模式</label>
                        <p className="text-xs text-slate-500">允许 AI 自动执行命令</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.agentEnabled ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, agentEnabled: value })}
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">自动执行</label>
                        <p className="text-xs text-slate-500">自动执行命令，无需手动确认</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.agentAutoExecute ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, agentAutoExecute: value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">最大执行步数</label>
                      <p className="text-xs text-slate-500 mb-2">智能体单次任务最多执行的命令数</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxExecutionSteps ?? 20;
                            if (current > 1) {
                              setLocalSettings({ ...localSettings, agentMaxExecutionSteps: current - 1 });
                            }
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
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
                          className="w-20 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded text-sm text-slate-900 dark:text-white text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxExecutionSteps ?? 20;
                            if (current < 100) {
                              setLocalSettings({ ...localSettings, agentMaxExecutionSteps: current + 1 });
                            }
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 上下文管理 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">上下文管理</h4>

                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">最大上下文消息数</label>
                      <p className="text-xs text-slate-500 mb-2">保留的对话历史消息数量</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxContextMessages ?? 20;
                            if (current > 5) {
                              setLocalSettings({ ...localSettings, agentMaxContextMessages: current - 1 });
                            }
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
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
                          className="w-20 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded text-sm text-slate-900 dark:text-white text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxContextMessages ?? 20;
                            if (current < 100) {
                              setLocalSettings({ ...localSettings, agentMaxContextMessages: current + 1 });
                            }
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">终端输出最大长度</label>
                      <p className="text-xs text-slate-500 mb-2">发送给 AI 的终端输出最大字符数（0 表示不限制）</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxTerminalOutputLength ?? 8000;
                            const newValue = current === 0 ? 0 : Math.max(0, current - 1000);
                            setLocalSettings({ ...localSettings, agentMaxTerminalOutputLength: newValue });
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
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
                          className="w-24 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded text-sm text-slate-900 dark:text-white text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentMaxTerminalOutputLength ?? 8000;
                            const newValue = Math.min(50000, current + 1000);
                            setLocalSettings({ ...localSettings, agentMaxTerminalOutputLength: newValue });
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">自动裁剪上下文</label>
                        <p className="text-xs text-slate-500">超过限制时自动裁剪旧消息</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.agentTrimContextEnabled ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, agentTrimContextEnabled: value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">任务上下文轮数</label>
                      <p className="text-xs text-slate-500 mb-2">保留最近N轮完成的任务作为上下文（实现任务联动）</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const current = localSettings.agentTaskContextRounds ?? 3;
                            if (current > 0) {
                              setLocalSettings({ ...localSettings, agentTaskContextRounds: current - 1 });
                            }
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
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
                          className="w-20 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded text-sm text-slate-900 dark:text-white text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => {
                            const current = localSettings.agentTaskContextRounds ?? 3;
                            if (current < 10) {
                              setLocalSettings({ ...localSettings, agentTaskContextRounds: current + 1 });
                            }
                          }}
                          className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-600 dark:text-slate-400 transition-colors"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <h3 className="font-medium text-slate-900 dark:text-white">安全设置</h3>

                <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-4">
                  <p className="text-sm text-yellow-600 dark:text-yellow-400">
                    当前密码以明文形式存储在本地配置文件中。建议使用系统密钥链或设置主密码来保护你的凭据。
                  </p>
                </div>

                {/* 命令审批 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-white mb-3">命令审批</h4>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">审批高风险命令</label>
                        <p className="text-xs text-slate-500">如 rm, chmod, kill 等</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.approveHighRisk ?? true}
                        onChange={(value) => setLocalSettings({ ...localSettings, approveHighRisk: value })}
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">审批中风险命令</label>
                        <p className="text-xs text-slate-500">如 mv, cp 等可能造成数据丢失的操作</p>
                      </div>
                      <ToggleButton
                        enabled={localSettings.approveMediumRisk ?? false}
                        onChange={(value) => setLocalSettings({ ...localSettings, approveMediumRisk: value })}
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm text-slate-600 dark:text-slate-400">记住本次选择</label>
                        <p className="text-xs text-slate-500">审批后记住本次会话的选择</p>
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
                <h3 className="font-medium text-slate-900 dark:text-white">通知设置</h3>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">连接状态通知</label>
                      <p className="text-xs text-slate-500">连接断开或重连时显示通知</p>
                    </div>
                    <ToggleButton
                      enabled={localSettings.connectionNotifications ?? true}
                      onChange={(value) => setLocalSettings({ ...localSettings, connectionNotifications: value })}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm text-slate-600 dark:text-slate-400">命令执行完成通知</label>
                      <p className="text-xs text-slate-500">AI 执行的命令完成时显示系统通知</p>
                    </div>
                    <ToggleButton
                      enabled={localSettings.commandNotifications ?? false}
                      onChange={(value) => setLocalSettings({ ...localSettings, commandNotifications: value })}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition-colors text-slate-900 dark:text-white"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors text-white"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
