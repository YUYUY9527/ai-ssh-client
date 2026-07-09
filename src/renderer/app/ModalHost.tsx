import { lazy, Suspense, type Dispatch, type SetStateAction } from 'react';
import { AlertCircle, CheckCircle2, FolderOpen, KeyRound, Loader2, Wifi, X } from 'lucide-react';

import type { AppSettings, CommandSuggestion, SSHConnection } from '../../shared/types';

const CommandApproval = lazy(async () => {
  const module = await import('../components/CommandApproval');
  return { default: module.CommandApproval };
});

const SettingsPanel = lazy(async () => {
  const module = await import('../settings/SettingsPanel');
  return { default: module.SettingsPanel };
});

interface ConnectionTestResult {
  success: boolean;
  message: string;
}

interface ModalHostProps {
  connectionTestResult: ConnectionTestResult | null;
  deletingConnection: string | null;
  editingConnection: SSHConnection | null;
  isSettingsOpen: boolean;
  pendingCommand: CommandSuggestion | null;
  settings: AppSettings;
  settingsInitialTab: 'terminal' | 'ssh' | 'providers' | 'security' | 'agent';
  testingConnection: boolean;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onApproveCommand: () => void;
  onChangeEditingConnection: Dispatch<SetStateAction<SSHConnection | null>>;
  onCloseSettings: () => void;
  onDeleteConnection: () => void;
  onRejectCommand: () => void;
  onSaveConnection: () => void;
  onSaveSettings: (settings: AppSettings) => Promise<void>;
  onSetConnectionTestResult: Dispatch<SetStateAction<ConnectionTestResult | null>>;
  onSetDeletingConnection: Dispatch<SetStateAction<string | null>>;
  onTestConnection: () => void;
}

function LazyModalFallback({ translate }: { translate: ModalHostProps['translate'] }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="industrial-modal px-6 py-5 flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
        <Loader2 className="w-5 h-5 animate-spin" />
        {translate('common.loading')}
      </div>
    </div>
  );
}

/** Central host for application-level settings, connection and approval modals. */
export function ModalHost({
  connectionTestResult,
  deletingConnection,
  editingConnection,
  isSettingsOpen,
  pendingCommand,
  settings,
  settingsInitialTab,
  testingConnection,
  translate,
  onApproveCommand,
  onChangeEditingConnection,
  onCloseSettings,
  onDeleteConnection,
  onRejectCommand,
  onSaveConnection,
  onSaveSettings,
  onSetConnectionTestResult,
  onSetDeletingConnection,
  onTestConnection,
}: ModalHostProps) {
  const handleSelectPrivateKey = async () => {
    if (!window.electronAPI) {
      return;
    }

    const result = await window.electronAPI.selectFile({
      title: translate('connection.form.selectPrivateKey'),
      filters: [
        { name: 'PEM Files', extensions: ['pem', 'key', 'ppk'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (!result.success || result.data?.canceled || !result.data?.filePath) {
      return;
    }

    const contentResult = await window.electronAPI.readPrivateKeyFile(result.data.filePath);
    if (contentResult.success && contentResult.data?.content) {
      onChangeEditingConnection((previous) => (
        previous ? { ...previous, privateKey: contentResult.data.content } : null
      ));
      onSetConnectionTestResult(null);
      return;
    }

    onSetConnectionTestResult({
      success: false,
      message: contentResult.error || translate('connection.form.privateKeyReadFailed'),
    });
  };

  return (
    <>
      {isSettingsOpen && (
        <Suspense fallback={<LazyModalFallback translate={translate} />}>
          <SettingsPanel
            settings={settings}
            onSave={onSaveSettings}
            onClose={onCloseSettings}
            initialTab={settingsInitialTab}
          />
        </Suspense>
      )}

      {editingConnection !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="industrial-modal w-full max-w-md">
            <div className="industrial-modal-header">
              <h3 className="font-semibold text-slate-900 dark:text-white">
                {editingConnection.id
                  ? translate('connection.editConnection')
                  : translate('connection.newConnection')}
              </h3>
              <button
                onClick={() => onChangeEditingConnection(null)}
                className="icon-button"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="industrial-field-label">{translate('connection.form.name')}</label>
                <input
                  type="text"
                  value={editingConnection.name || ''}
                  onChange={(event) => onChangeEditingConnection((previous) => (
                    previous ? { ...previous, name: event.target.value } : null
                  ))}
                  className="industrial-input w-full"
                  placeholder="My Server"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="industrial-field-label">{translate('connection.form.host')}</label>
                  <input
                    type="text"
                    value={editingConnection.host || ''}
                    onChange={(event) => onChangeEditingConnection((previous) => (
                      previous ? { ...previous, host: event.target.value } : null
                    ))}
                    className="industrial-input w-full"
                    placeholder="192.168.1.100"
                  />
                </div>
                <div>
                  <label className="industrial-field-label">{translate('connection.form.port')}</label>
                  <input
                    type="number"
                    value={editingConnection.port || 22}
                    onChange={(event) => onChangeEditingConnection((previous) => (
                      previous ? { ...previous, port: parseInt(event.target.value, 10) || 22 } : null
                    ))}
                    className="industrial-input w-full"
                    placeholder="22"
                  />
                </div>
              </div>
              <div>
                <label className="industrial-field-label">
                  {translate('connection.form.username')}
                </label>
                <input
                  type="text"
                  value={editingConnection.username || ''}
                  onChange={(event) => onChangeEditingConnection((previous) => (
                    previous ? { ...previous, username: event.target.value } : null
                  ))}
                  className="industrial-input w-full"
                  placeholder="root"
                />
              </div>
              <div>
                <label className="industrial-field-label">
                  {translate('connection.form.password')}
                </label>
                <input
                  type="password"
                  value={editingConnection.password || ''}
                  onChange={(event) => onChangeEditingConnection((previous) => (
                    previous ? { ...previous, password: event.target.value } : null
                  ))}
                  className="industrial-input w-full"
                  placeholder="********"
                />
              </div>
              <div className="industrial-card space-y-3 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-sm border border-teal-500/35 bg-teal-500/10">
                      <KeyRound className="h-4 w-4 text-teal-500" />
                    </span>
                    <div className="min-w-0">
                      <label className="industrial-field-label mb-0">
                        {translate('connection.form.authByKey')}
                      </label>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {translate('connection.form.privateKey')}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleSelectPrivateKey}
                    className="industrial-button-secondary shrink-0 px-3 py-1.5"
                  >
                    <FolderOpen className="h-4 w-4" />
                    {translate('connection.form.selectPrivateKey')}
                  </button>
                </div>
                <textarea
                  value={editingConnection.privateKey || ''}
                  onChange={(event) => onChangeEditingConnection((previous) => (
                    previous ? { ...previous, privateKey: event.target.value } : null
                  ))}
                  className="industrial-input h-24 w-full resize-none font-mono text-xs"
                  placeholder={translate('connection.form.privateKeyPlaceholder')}
                />
                {editingConnection.privateKey && (
                  <div>
                    <label className="industrial-field-label">
                      {translate('connection.form.passphrase')}
                    </label>
                    <input
                      type="password"
                      value={editingConnection.passphrase || ''}
                      onChange={(event) => onChangeEditingConnection((previous) => (
                        previous ? { ...previous, passphrase: event.target.value } : null
                      ))}
                      className="industrial-input w-full"
                      placeholder={translate('connection.form.passphrasePlaceholder')}
                    />
                  </div>
                )}
              </div>
              {connectionTestResult && (
                <div className={`industrial-card flex items-center gap-2 px-3 py-2 ${
                  connectionTestResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                }`}
                >
                  {connectionTestResult.success ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <AlertCircle className="w-4 h-4" />
                  )}
                  <span className="text-sm">{connectionTestResult.message}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={onTestConnection}
                  disabled={testingConnection || !editingConnection.host || !editingConnection.username}
                  className="industrial-button-secondary"
                >
                  {testingConnection ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Wifi className="w-4 h-4" />
                  )}
                  {translate('connection.testConnection')}
                </button>

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      onChangeEditingConnection(null);
                      onSetConnectionTestResult(null);
                    }}
                    className="industrial-button-secondary"
                  >
                    {translate('common.cancel')}
                  </button>
                  <button
                    onClick={onSaveConnection}
                    disabled={
                      !editingConnection.name
                      || !editingConnection.host
                      || !editingConnection.username
                    }
                    className="industrial-button-primary"
                  >
                    {translate('common.save')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {deletingConnection && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="industrial-modal w-full max-w-sm">
            <div className="industrial-modal-header">
              <h3 className="font-semibold text-slate-900 dark:text-white">
                {translate('connection.confirmDeleteTitle')}
              </h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {translate('connection.confirmDelete')}
              </p>
            </div>
            <div className="industrial-modal-footer">
              <button
                onClick={() => onSetDeletingConnection(null)}
                className="industrial-button-secondary"
              >
                {translate('common.cancel')}
              </button>
              <button
                onClick={onDeleteConnection}
                className="industrial-button-danger"
              >
                {translate('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingCommand && (
        <Suspense fallback={<LazyModalFallback translate={translate} />}>
          <CommandApproval
            command={pendingCommand}
            onApprove={onApproveCommand}
            onReject={onRejectCommand}
          />
        </Suspense>
      )}
    </>
  );
}
