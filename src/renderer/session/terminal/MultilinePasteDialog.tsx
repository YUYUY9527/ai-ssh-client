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
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const lineCount = previewText ? previewText.split(/\r\n|\r|\n/).length : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      size="lg"
      showClose={false}
      initialFocusRef={cancelButtonRef}
      labelledBy={titleId}
      describedBy={messageId}
      panelClassName="flex flex-col !overflow-hidden"
    >
      <div className="industrial-modal-header shrink-0">
        <div className="flex items-center gap-2.5">
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning-fg" />
          <h3 id={titleId} className="font-semibold text-fg">
            {translate('terminal.multilinePasteTitle')}
          </h3>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p id={messageId} className="text-sm leading-6 text-fg-secondary">
          {translate('terminal.multilinePasteHint')}
        </p>
        {vimSafeAvailable && (
          <div className="flex gap-2 rounded-md border border-[color-mix(in_srgb,var(--warning)_45%,var(--border-color))] bg-warning-muted p-3 text-xs leading-5 text-warning-fg">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" />
            <span>{translate('terminal.multilinePasteVimHint')}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span>{translate('terminal.multilinePasteLines', { count: lineCount })}</span>
        </div>
        <pre className="scrollbar-thin max-h-64 overflow-auto rounded-md border border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_70%,transparent)] p-3 font-mono text-xs leading-5 text-fg whitespace-pre-wrap break-all">
          {previewText}
        </pre>
      </div>

      <div className="industrial-modal-footer shrink-0">
        <button
          type="button"
          ref={cancelButtonRef}
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
          onClick={onConfirm}
          className="industrial-button-danger"
        >
          {translate('terminal.multilinePasteConfirm')}
        </button>
      </div>
    </Modal>
  );
}
