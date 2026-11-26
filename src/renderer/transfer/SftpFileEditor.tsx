import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, GitCompare, Loader2, RotateCcw, Save, Wand2 } from 'lucide-react';
import { computeLineDiff } from './line-diff';

import { useI18n } from '../i18n';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../shared-ui/Modal';
import { useSessionOverlay } from '../workspace/SessionOverlayContext';
import { MAX_SFTP_EDIT_BYTES } from '../../shared/ipc-types';
import { canSaveSftpDraft } from './sftp-editor-save';
import { detectCodeLanguage, formatCodeContent } from './code-format';

// CodeMirror 体积较大，按需懒加载，避免拖慢应用启动
const CodeEditor = lazy(() => import('./CodeEditor').then((module) => ({ default: module.CodeEditor })));

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
  const overlay = useSessionOverlay();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 是否成功读取过远端文件。读取失败时为 false，用于阻止任何写回（按钮与快捷键共用）。
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  const [draft, setDraft] = useState('');
  const [maxBytes, setMaxBytes] = useState(MAX_SFTP_EDIT_BYTES);
  // sudo 密码：普通 SFTP 无权限时才会用到；仅保存在本组件内存中，不落盘。
  const [sudoPassword, setSudoPassword] = useState('');
  const [sudoRequired, setSudoRequired] = useState(false);
  const sudoInputRef = useRef<HTMLInputElement>(null);
  const [confirmKind, setConfirmKind] = useState<'yaml-format' | 'discard' | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const editDiff = useMemo(
    () => (showDiff ? computeLineDiff(original, draft) : null),
    [showDiff, original, draft],
  );

  useEffect(() => {
    if (sudoRequired) {
      sudoInputRef.current?.focus();
    }
  }, [sudoRequired]);

  const dirty = draft !== original;
  const draftBytes = useMemo(() => new TextEncoder().encode(draft).length, [draft]);
  const overLimit = draftBytes > maxBytes;
  // 保存条件：按钮 disabled、Ctrl/Cmd+S 调用的 handleSave 都用它，避免两条路径不一致。
  const canSave = canSaveSftpDraft({ loaded, loading, saving, dirty, overLimit });

  const language = useMemo(() => detectCodeLanguage(remotePath), [remotePath]);
  const canFormat = language !== 'text' && loaded && !loading && !saving;

  const applyFormat = useCallback(() => {
    const result = formatCodeContent(language, draft);
    if (!result.ok) {
      setError(t('fileTransfer.editFormatFailed', { error: result.error }));
      setStatus(null);
      return;
    }
    setDraft(result.content);
    setError(null);
    setStatus(t('fileTransfer.editFormatted'));
  }, [draft, language, t]);

  const handleFormat = useCallback(() => {
    // js-yaml 重新序列化会丢失注释/锚点，YAML 先经应用内弹窗确认再动
    if (language === 'yaml') {
      setConfirmKind('yaml-format');
      return;
    }
    applyFormat();
  }, [applyFormat, language]);

  /** 过大/不可编辑：优先走居中弹窗，避免埋在编辑器页内 */
  const alertAndClose = useCallback((message: string) => {
    if (onAlert) {
      onAlert(message);
      return;
    }
    setError(message);
  }, [onAlert]);

  const loadFile = useCallback(async (password?: string) => {
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
    setLoaded(false);
    setError(null);
    setStatus(null);
    try {
      const result = await window.electronAPI.readSftpTextFile(connectionId, remotePath, password || undefined);
      if (!result.success || !result.data) {
        const message = result.success === false ? result.error : t('fileTransfer.editLoadFailed');
        if (/SUDO_PASSWORD_REQUIRED/.test(message || '')) {
          setSudoRequired(true);
          setError(t('fileTransfer.sudoRequired'));
          setOriginal('');
          setDraft('');
          return;
        }
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
      setSudoRequired(false);
      setOriginal(result.data.content);
      setDraft(result.data.content);
      setLoaded(true);
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
    // 与保存按钮 disabled 使用同一个 canSave：读取失败(loaded=false)时快捷键也不会写回。
    if (!canSave || !window.electronAPI?.writeSftpTextFile) {
      return;
    }
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const result = await window.electronAPI.writeSftpTextFile(connectionId, remotePath, draft, sudoPassword || undefined);
      if (!result.success) {
        const message = result.error || t('fileTransfer.editSaveFailed');
        if (/SUDO_PASSWORD_REQUIRED/.test(message)) {
          setSudoRequired(true);
          setError(t('fileTransfer.sudoRequired'));
          return;
        }
        setError(message);
        return;
      }
      setSudoRequired(false);
      setOriginal(draft);
      setStatus(t('fileTransfer.editSaved', { size: formatBytes(draftBytes) }));
    } catch (err) {
      const message = (err as Error).message || t('fileTransfer.editSaveFailed');
      if (/SUDO_PASSWORD_REQUIRED/.test(message)) {
        setSudoRequired(true);
        setError(t('fileTransfer.sudoRequired'));
        return;
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [canSave, connectionId, draft, draftBytes, remotePath, sudoPassword, t]);

  const handleReset = useCallback(() => {
    setDraft(original);
    setError(null);
    setStatus(t('fileTransfer.editReset'));
  }, [original, t]);

  // Ctrl/Cmd+S 保存（仅当前激活会话的编辑器响应，避免后台会话截获快捷键）
  useEffect(() => {
    if (!isOpen || !overlay.isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleSave, isOpen, overlay.isActive]);

  const handleClose = () => {
    if (dirty) {
      setConfirmKind('discard');
      return;
    }
    onClose();
  };

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="4xl"
      closeLabel={t('common.close')}
      panelClassName={
        overlay.container
          ? 'flex !h-[min(96%,900px)] !max-h-full flex-col !overflow-hidden'
          : 'flex !h-[min(92vh,900px)] !max-h-[min(92vh,900px)] flex-col !overflow-hidden'
      }
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <FileCode2 className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate font-mono text-sm" title={remotePath}>{remotePath}</span>
          {dirty && (
            <span className="shrink-0 rounded-sm bg-warning-muted px-1.5 py-0.5 text-[10px] font-medium text-warning-fg">
              {t('fileTransfer.editDirty')}
            </span>
          )}
        </span>
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="industrial-button-primary px-3 py-1.5 text-xs"
            disabled={!canSave}
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
          {language !== 'text' && (
            <button
              type="button"
              className="industrial-button-secondary px-3 py-1.5 text-xs"
              disabled={!canFormat}
              onClick={handleFormat}
              title={t('fileTransfer.editFormat')}
            >
              <Wand2 className="h-3.5 w-3.5" />
              {t('fileTransfer.editFormat')}
            </button>
          )}
          <button
            type="button"
            className={`industrial-button-secondary px-3 py-1.5 text-xs ${showDiff ? 'border-accent text-accent' : ''}`}
            disabled={loading || !loaded || !dirty}
            onClick={() => setShowDiff((prev) => !prev)}
            title={t('fileTransfer.editDiffToggle')}
          >
            <GitCompare className="h-3.5 w-3.5" />
            {showDiff ? t('fileTransfer.editDiffBack') : t('fileTransfer.editDiffToggle')}
          </button>
        </div>
        <span className={`shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums ${overLimit ? 'text-danger-fg' : 'text-fg-muted'}`}>
          {formatBytes(draftBytes)} / {formatBytes(maxBytes)}
          {overLimit ? ` · ${t('fileTransfer.editOverLimit')}` : ''}
        </span>
      </div>

      {/* 中间编辑区占满剩余高度，便于长文本编辑 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            {t('common.loading')}
          </div>
        ) : !loaded && error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-danger-fg">
            {error}
          </div>
        ) : showDiff && editDiff ? (
          <div className="scrollbar-thin h-full overflow-auto bg-[var(--bg-primary)] font-mono text-[11px] leading-5">
            <div className="sticky top-0 flex items-center gap-3 border-b border-line-subtle bg-surface px-3 py-1.5 text-[11px]">
              <span className="text-success">+{editDiff.added}</span>
              <span className="text-danger">-{editDiff.removed}</span>
              <span className="text-fg-muted">{t('fileTransfer.diffUnchanged', { count: editDiff.unchanged })}</span>
            </div>
            <div className="py-1">
              {editDiff.lines.map((line, index) => (
                <div
                  key={index}
                  className={`flex whitespace-pre-wrap break-all px-3 ${
                    line.kind === 'add'
                      ? 'bg-success-muted text-success'
                      : line.kind === 'remove'
                        ? 'bg-danger-muted text-danger'
                        : 'text-fg-secondary'
                  }`}
                >
                  <span className="w-9 shrink-0 select-none pr-2 text-right text-fg-subtle tabular-nums">
                    {line.leftLine ?? ''}
                  </span>
                  <span className="w-9 shrink-0 select-none pr-2 text-right text-fg-subtle tabular-nums">
                    {line.rightLine ?? ''}
                  </span>
                  <span className="w-4 shrink-0 select-none font-semibold">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                  </span>
                  <span className="min-w-0 flex-1">{line.text}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Suspense
            fallback={(
              <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                {t('common.loading')}
              </div>
            )}
          >
            <CodeEditor
              value={draft}
              language={language}
              readOnly={saving}
              onChange={(next) => {
                setDraft(next);
                setStatus(null);
                setError(null);
              }}
            />
          </Suspense>
        )}
      </div>

      {sudoRequired ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void (loaded ? handleSave() : loadFile(sudoPassword));
          }}
          className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-surface-raised px-4 py-2 text-xs"
        >
          <span className="text-fg-secondary">{t('fileTransfer.sudoHint')}</span>
          <input
            ref={sudoInputRef}
            type="password"
            className="industrial-input h-7 w-44 px-2 py-0 text-xs leading-none"
            placeholder={t('fileTransfer.sudoPasswordPlaceholder')}
            value={sudoPassword}
            onChange={(event) => setSudoPassword(event.target.value)}
          />
          <button
            type="submit"
            className="industrial-button-primary h-7 px-3 py-0 text-xs"
          >
            {t('fileTransfer.sudoRetry')}
          </button>
        </form>
      ) : null}

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] px-4 py-2 text-xs">
        <span className="min-w-0 truncate text-fg-muted">
          {loaded && error ? <span className="text-danger-fg">{error}</span> : (status || t('fileTransfer.editHint'))}
        </span>
        <button type="button" className="industrial-button-secondary shrink-0 px-3 py-1.5 text-xs" onClick={handleClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
    <ConfirmDialog
      isOpen={confirmKind !== null}
      title={confirmKind === 'yaml-format' ? t('fileTransfer.editFormat') : t('common.close')}
      message={confirmKind === 'yaml-format' ? t('fileTransfer.editFormatYamlConfirm') : t('fileTransfer.editDiscardConfirm')}
      onConfirm={() => {
        const kind = confirmKind;
        setConfirmKind(null);
        if (kind === 'yaml-format') {
          applyFormat();
        } else if (kind === 'discard') {
          onClose();
        }
      }}
      onCancel={() => setConfirmKind(null)}
    />
    </>
  );
}
