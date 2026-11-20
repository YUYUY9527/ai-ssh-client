import { useId, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '../../shared-ui/Modal';

interface MultilinePasteDialogProps {
  isOpen: boolean;
  previewText: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 当前是旧版 Vim（不支持 bracketed paste）时为 true，提示并提供安全粘贴。 */
  vimSafeAvailable?: boolean;
  onVimSafePaste?: () => void;
}

/** 多行粘贴预览与安全确认弹窗。 */
export function MultilinePasteDialog({
  isOpen,
  previewText,
  translate,
  onConfirm,
  onCancel,
  vimSafeAvailable = false,
  onVimSafePaste,
}: MultilinePasteDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const lineCount = previewText ? previewText.split(/\r\n|\r|\n/).length : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      size="lg"
      showClose={false}
      initialFocusRef={confirmButtonRef}
      labelledBy={titleId}
      describedBy={messageId}
    >
      <div className="industrial-modal-header">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-warning" />
          <h3 id={titleId} className="font-semibold text-fg dark:text-white">
            {translate('terminal.multilinePasteTitle')}
          </h3>
        </div>
      </div>

      <div className="space-y-3 p-4">
        <p id={messageId} className="text-sm leading-6 text-fg-secondary">
          {translate('terminal.multilinePasteHint')}
        </p>
        {vimSafeAvailable && (
          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs leading-5 text-fg-secondary">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>{translate('terminal.multilinePasteVimHint')}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span>{translate('terminal.multilinePasteLines', { count: lineCount })}</span>
        </div>
        <pre className="scrollbar-modern max-h-64 overflow-auto rounded-md border border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_70%,transparent)] p-3 text-xs leading-5 text-fg whitespace-pre-wrap break-all">
          {previewText}
        </pre>
      </div>

      <div className="industrial-modal-footer">
        <button
          type="button"
          onClick={onCancel}
          className="industrial-button-secondary"
        >
          {translate('terminal.multilinePasteCancel')}
        </button>
        {vimSafeAvailable && onVimSafePaste && (
          <button type="button" onClick={onVimSafePaste} className="industrial-button-primary">
            {translate('terminal.multilinePasteVimConfirm')}
          </button>
        )}
        <button
          type="button"
          ref={confirmButtonRef}
          onClick={onConfirm}
          className="industrial-button-danger"
        >
          {translate('terminal.multilinePasteConfirm')}
        </button>
      </div>
    </Modal>
  );
}
