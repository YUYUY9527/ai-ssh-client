import { useMemo, useRef, useState } from 'react';
import { Download, FileUp, KeyRound, Shield, Upload } from 'lucide-react';
import type { SSHConnection } from '../../shared/types';
import { useI18n } from '../i18n';
import { Modal } from '../shared-ui/Modal';
import {
  decryptBackupPayload,
  encryptBackupPayload,
  isEncryptedBackup,
} from './backup-crypto';
import {
  downloadTextFile,
  extractConnectionsFromBackup,
  findConnectionConflicts,
  readFileAsText,
  unwrapBackupData,
  type BackupConflict,
} from './backup-utils';
import { parseOpenSshConfig } from './parse-openssh-config';

type Mode = 'export' | 'import';
type ImportKind = 'backup' | 'openssh';

interface ConnectionImportExportModalProps {
  isOpen: boolean;
  mode: Mode;
  existingConnections: SSHConnection[];
  onClose: () => void;
  onImported: () => void | Promise<void>;
}

export function ConnectionImportExportModal({
  isOpen,
  mode,
  existingConnections,
  onClose,
  onImported,
}: ConnectionImportExportModalProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [importKind, setImportKind] = useState<ImportKind>('backup');
  const [merge, setMerge] = useState(true);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null);
  const [conflicts, setConflicts] = useState<BackupConflict[]>([]);
  const [previewCount, setPreviewCount] = useState(0);

  const title = mode === 'export'
    ? t('connection.importExport.exportTitle')
    : t('connection.importExport.importTitle');

  const canSubmitExport = !usePassword || password.trim().length >= 4;
  // 加密包必须输入密码后才能确认导入
  const canConfirmImport = Boolean(pendingPayload) && (
    !isEncryptedBackup(pendingPayload) || password.trim().length >= 4
  );

  const conflictSummary = useMemo(() => {
    if (conflicts.length === 0) {
      return t('connection.importExport.noConflicts');
    }
    return t('connection.importExport.conflictCount', { count: conflicts.length });
  }, [conflicts, t]);

  const resetState = () => {
    setStatus(null);
    setBusy(false);
    setPendingPayload(null);
    setConflicts([]);
    setPreviewCount(0);
    setPassword('');
    setUsePassword(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleExport = async () => {
    if (!window.electronAPI) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.exportAllData({ includeSecrets });
      if (!result.success || !result.data?.data) {
        throw new Error(result.success ? t('connection.importExport.exportFailed') : result.error);
      }

      let packageData: Record<string, unknown> = result.data.data;
      if (usePassword) {
        packageData = await encryptBackupPayload(packageData, password.trim());
      }

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = usePassword
        ? `ai-ssh-backup-${stamp}.enc.json`
        : `ai-ssh-backup-${stamp}.json`;
      downloadTextFile(filename, JSON.stringify(packageData, null, 2));
      setStatus({ type: 'success', text: t('connection.importExport.exportSuccess') });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('connection.importExport.exportFailed');
      setStatus({ type: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const prepareImportPreview = async (rawText: string) => {
    let parsed: unknown;
    try {
      if (importKind === 'openssh') {
        const connections = parseOpenSshConfig(rawText);
        if (connections.length === 0) {
          throw new Error(t('connection.importExport.opensshEmpty'));
        }
        const payload = { version: 'ai-ssh-client-1', connections };
        setPendingPayload(payload);
        setPreviewCount(connections.length);
        setConflicts(findConnectionConflicts(existingConnections, connections));
        setStatus({
          type: 'success',
          text: t('connection.importExport.previewReady', { count: connections.length }),
        });
        return;
      }

      parsed = JSON.parse(rawText);
    } catch (error) {
      if (importKind === 'openssh') {
        throw error;
      }
      throw new Error(t('connection.importExport.invalidJson'));
    }

    let payload = unwrapBackupData(parsed);
    if (isEncryptedBackup(payload)) {
      if (!password.trim()) {
        setPendingPayload(payload);
        setUsePassword(true);
        setStatus({ type: 'error', text: t('connection.importExport.needPassword') });
        return;
      }
      payload = unwrapBackupData(await decryptBackupPayload(payload, password.trim()));
    }

    const connections = extractConnectionsFromBackup(payload);
    setPendingPayload(payload);
    setPreviewCount(connections.length);
    setConflicts(findConnectionConflicts(existingConnections, connections));
    setStatus({
      type: 'success',
      text: t('connection.importExport.previewReady', { count: connections.length }),
    });
  };

  const handlePickFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setStatus(null);
    try {
      const text = await readFileAsText(file);
      await prepareImportPreview(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('connection.importExport.importFailed');
      setStatus({ type: 'error', text: message });
      setPendingPayload(null);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!window.electronAPI || !pendingPayload) return;
    setBusy(true);
    setStatus(null);
    try {
      let payload = pendingPayload;
      if (isEncryptedBackup(payload)) {
        if (!password.trim()) {
          throw new Error(t('connection.importExport.needPassword'));
        }
        payload = unwrapBackupData(await decryptBackupPayload(payload, password.trim()));
      }

      const result = await window.electronAPI.importData(payload, { merge });
      if (!result.success) {
        throw new Error(result.error || t('connection.importExport.importFailed'));
      }

      const imported = result.data?.imported;
      await onImported();
      setStatus({
        type: 'success',
        text: t('connection.importExport.importSuccess', {
          connections: imported?.connections ?? 0,
          providers: imported?.aiProviders ?? 0,
        }),
      });
      setPendingPayload(null);
      setConflicts([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('connection.importExport.importFailed');
      setStatus({ type: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="lg">
      <div className="space-y-4 p-4 sm:p-5">
        {mode === 'export' ? (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {t('connection.importExport.exportDesc')}
            </p>
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeSecrets}
                onChange={(event) => setIncludeSecrets(event.target.checked)}
              />
              <span>
                <span className="inline-flex items-center gap-1 font-medium">
                  <KeyRound className="h-3.5 w-3.5" />
                  {t('connection.importExport.includeSecrets')}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {t('connection.importExport.includeSecretsDesc')}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={usePassword}
                onChange={(event) => setUsePassword(event.target.checked)}
              />
              <span>
                <span className="inline-flex items-center gap-1 font-medium">
                  <Shield className="h-3.5 w-3.5" />
                  {t('connection.importExport.encryptBackup')}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {t('connection.importExport.encryptBackupDesc')}
                </span>
              </span>
            </label>
            {usePassword && (
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="industrial-input w-full"
                placeholder={t('connection.importExport.passwordPlaceholder')}
              />
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {t('connection.importExport.importDesc')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className={`industrial-button-secondary justify-center ${importKind === 'backup' ? 'ring-1 ring-teal-500' : ''}`}
                onClick={() => {
                  setImportKind('backup');
                  setPendingPayload(null);
                  setConflicts([]);
                }}
              >
                {t('connection.importExport.kindBackup')}
              </button>
              <button
                type="button"
                className={`industrial-button-secondary justify-center ${importKind === 'openssh' ? 'ring-1 ring-teal-500' : ''}`}
                onClick={() => {
                  setImportKind('openssh');
                  setPendingPayload(null);
                  setConflicts([]);
                }}
              >
                {t('connection.importExport.kindOpenSsh')}
              </button>
            </div>

            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={merge}
                onChange={(event) => setMerge(event.target.checked)}
              />
              <span>
                <span className="font-medium">{t('connection.importExport.mergeMode')}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {merge
                    ? t('connection.importExport.mergeModeDesc')
                    : t('connection.importExport.replaceModeDesc')}
                </span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={importKind === 'openssh' ? '.config,text/plain,*/*' : '.json,application/json,*/*'}
                className="hidden"
                onChange={(event) => {
                  void handlePickFile(event.target.files?.[0] || null);
                }}
              />
              <button
                type="button"
                className="industrial-button-secondary"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="h-4 w-4" />
                {t('connection.importExport.chooseFile')}
              </button>
              {previewCount > 0 && (
                <span className="text-xs text-slate-500">
                  {t('connection.importExport.previewConnections', { count: previewCount })}
                </span>
              )}
            </div>

            {(usePassword || isEncryptedBackup(pendingPayload)) && (
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="industrial-input w-full"
                placeholder={t('connection.importExport.passwordPlaceholder')}
              />
            )}

            {pendingPayload && (
              <div className="industrial-card space-y-2 p-3">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  {conflictSummary}
                </p>
                {conflicts.length > 0 && (
                  <ul className="max-h-36 space-y-1 overflow-y-auto text-xs text-slate-500">
                    {conflicts.slice(0, 20).map((item) => (
                      <li key={`${item.incoming.id}-${item.existing.id}`}>
                        {item.incoming.name} ← {item.existing.name}
                        {' '}
                        ({item.reason === 'id'
                          ? t('connection.importExport.conflictById')
                          : t('connection.importExport.conflictByEndpoint')})
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-slate-500">
                  {merge
                    ? t('connection.importExport.conflictMergeHint')
                    : t('connection.importExport.conflictReplaceHint')}
                </p>
              </div>
            )}
          </>
        )}

        {status && (
          <div
            className={`rounded-sm border px-3 py-2 text-sm ${
              status.type === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300'
            }`}
          >
            {status.text}
          </div>
        )}
      </div>

      <div className="industrial-modal-footer">
        <button type="button" className="industrial-button-secondary" onClick={handleClose}>
          {t('common.close')}
        </button>
        {mode === 'export' ? (
          <button
            type="button"
            className="industrial-button-primary"
            disabled={busy || !canSubmitExport}
            onClick={() => {
              void handleExport();
            }}
          >
            <Download className="h-4 w-4" />
            {busy ? t('common.loading') : t('connection.importExport.exportAction')}
          </button>
        ) : (
          <button
            type="button"
            className="industrial-button-primary"
            disabled={busy || !pendingPayload || !canConfirmImport}
            onClick={() => {
              void handleConfirmImport();
            }}
          >
            <Upload className="h-4 w-4" />
            {busy ? t('common.loading') : t('connection.importExport.importAction')}
          </button>
        )}
      </div>
    </Modal>
  );
}
