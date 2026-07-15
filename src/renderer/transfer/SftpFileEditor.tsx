import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, Loader2, RotateCcw, Save } from 'lucide-react';

import { useI18n } from '../i18n';
import { Modal } from '../shared-ui/Modal';
import { MAX_SFTP_EDIT_BYTES } from '../../shared/ipc-types';

interface SftpFileEditorProps {
  isOpen: boolean;
  connectionId: string;
  remotePath: string;
  /** 列表中的已知大小；超限时不发起读取 */
  knownSize?: number;
  onClose: () => void;
  /** 无法编辑时用居中弹窗提示（如文件过大），而不是编辑器内顶部文案 */
  onAlert?: (message: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** SFTP 远端文本在线编辑器：保存 / 重置 / Ctrl+S，带最大体积限制。 */
export function SftpFileEditor({
  isOpen,
  connectionId,
  remotePath,
  knownSize,
  onClose,
  onAlert,
}: SftpFileEditorProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  const [draft, setDraft] = useState('');
  const [maxBytes, setMaxBytes] = useState(MAX_SFTP_EDIT_BYTES);

  const dirty = draft !== original;
  const draftBytes = useMemo(() => new TextEncoder().encode(draft).length, [draft]);
  const overLimit = draftBytes > maxBytes;

  /** 过大/不可编辑：优先走居中弹窗，避免埋在编辑器页内 */
  const alertAndClose = useCallback((message: string) => {
    if (onAlert) {
      onAlert(message);
      return;
    }
    setError(message);
  }, [onAlert]);

  const loadFile = useCallback(async () => {
    if (!window.electronAPI?.readSftpTextFile) {
      alertAndClose(t('fileTransfer.editUnsupported'));
      return;
    }
    if (typeof knownSize === 'number' && knownSize > MAX_SFTP_EDIT_BYTES) {
      alertAndClose(t('fileTransfer.editTooLarge', {
        size: formatBytes(knownSize),
        max: formatBytes(MAX_SFTP_EDIT_BYTES),
      }));
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const result = await window.electronAPI.readSftpTextFile(connectionId, remotePath);
      if (!result.success || !result.data) {
        const message = result.success === false ? result.error : t('fileTransfer.editLoadFailed');
        const tooLarge = /too large|过大|max \d+ bytes/i.test(message || '');
        if (tooLarge) {
          alertAndClose(message || t('fileTransfer.editLoadFailed'));
          return;
        }
        setError(message || t('fileTransfer.editLoadFailed'));
        setOriginal('');
        setDraft('');
        return;
      }
      setOriginal(result.data.content);
      setDraft(result.data.content);
      setMaxBytes(result.data.maxBytes || MAX_SFTP_EDIT_BYTES);
      setStatus(t('fileTransfer.editLoaded', {
        size: formatBytes(result.data.size),
        max: formatBytes(result.data.maxBytes || MAX_SFTP_EDIT_BYTES),
      }));
    } catch (err) {
      const message = (err as Error).message || t('fileTransfer.editLoadFailed');
      if (/too large|过大|max \d+ bytes/i.test(message)) {
        alertAndClose(message);
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [alertAndClose, connectionId, knownSize, remotePath, t]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadFile();
  }, [isOpen, loadFile]);

  const handleSave = useCallback(async () => {
    if (!window.electronAPI?.writeSftpTextFile || saving || loading || overLimit) {
      return;
    }
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const result = await window.electronAPI.writeSftpTextFile(connectionId, remotePath, draft);
      if (!result.success) {
        setError(result.error || t('fileTransfer.editSaveFailed'));
        return;
      }
      setOriginal(draft);
      setStatus(t('fileTransfer.editSaved', { size: formatBytes(draftBytes) }));
    } catch (err) {
      setError((err as Error).message || t('fileTransfer.editSaveFailed'));
    } finally {
      setSaving(false);
    }
  }, [connectionId, draft, draftBytes, loading, overLimit, remotePath, saving, t]);

  const handleReset = useCallback(() => {
    setDraft(original);
    setError(null);
    setStatus(t('fileTransfer.editReset'));
  }, [original, t]);

  // Ctrl/Cmd+S 保存
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleSave, isOpen]);

  const handleClose = () => {
    if (dirty && !window.confirm(t('fileTransfer.editDiscardConfirm'))) {
      return;
    }
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="4xl"
      closeLabel={t('common.close')}
      panelClassName="flex !h-[min(92vh,900px)] !max-h-[min(92vh,900px)] flex-col !overflow-hidden"
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <FileCode2 className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate font-mono text-sm" title={remotePath}>{remotePath}</span>
          {dirty && (
            <span className="shrink-0 rounded-sm bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-warning">
              {t('fileTransfer.editDirty')}
            </span>
          )}
        </span>
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] px-4 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="industrial-button-primary px-3 py-1.5 text-xs"
            disabled={loading || saving || !dirty || overLimit || Boolean(error && !draft && !original)}
            onClick={() => void handleSave()}
            title={`${t('common.save')} (Ctrl+S)`}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('common.save')}
          </button>
          <button
            type="button"
            className="industrial-button-secondary px-3 py-1.5 text-xs"
            disabled={loading || saving || !dirty}
            onClick={handleReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('fileTransfer.editResetAction')}
          </button>
        </div>
        <span className={`text-[11px] tabular-nums ${overLimit ? 'text-danger' : 'text-slate-500'}`}>
          {formatBytes(draftBytes)} / {formatBytes(maxBytes)}
          {overLimit ? ` · ${t('fileTransfer.editOverLimit')}` : ''}
        </span>
      </div>

      {/* 中间编辑区占满剩余高度，便于长文本编辑 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full min-h-[360px] items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : error && !original && !draft ? (
          <div className="flex h-full min-h-[360px] items-center justify-center px-6 text-center text-sm text-danger">
            {error}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setStatus(null);
              setError(null);
            }}
            className="industrial-input scrollbar-thin absolute inset-0 h-full w-full resize-none overflow-y-auto rounded-none border-0 font-mono text-sm leading-6 focus:ring-0"
            spellCheck={false}
            disabled={saving}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] px-4 py-2 text-xs">
        <span className="min-w-0 truncate text-slate-500">
          {error ? <span className="text-danger">{error}</span> : (status || t('fileTransfer.editHint'))}
        </span>
        <button type="button" className="industrial-button-secondary px-3 py-1.5 text-xs" onClick={handleClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
