import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { useId, useRef } from 'react';
import { useI18n } from '../i18n';
import { Modal } from '../shared-ui/Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isConfirming?: boolean;
  type?: 'warning' | 'info';
}

/** 通用确认弹窗，复用 Modal 基座获得 Esc 关闭、点遮罩关闭与焦点陷阱 */
export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  isConfirming = false,
  type = 'warning',
}: ConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const { t } = useI18n();

  const resolvedConfirmText = confirmText ?? t('common.confirm');
  const resolvedCancelText = cancelText ?? t('common.cancel');

  return (
    <Modal
      isOpen={isOpen}
      onClose={isConfirming ? () => undefined : onCancel}
      size="md"
      showClose={false}
      initialFocusRef={type === 'warning' ? cancelButtonRef : confirmButtonRef}
      labelledBy={titleId}
      describedBy={messageId}
      panelClassName="flex flex-col !overflow-hidden"
    >
      <div className="industrial-modal-header shrink-0">
        <div className="flex min-w-0 items-center gap-2.5">
          {type === 'warning' ? (
            <AlertTriangle className="h-5 w-5 shrink-0 text-warning-fg" />
          ) : (
            <Info className="h-5 w-5 shrink-0 text-accent" />
          )}
          <h3 id={titleId} className="min-w-0 truncate font-semibold text-fg">
            {title}
          </h3>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
        <p id={messageId} className="break-words text-sm leading-6 text-fg-secondary">
          {message}
        </p>
      </div>

      <div className="industrial-modal-footer shrink-0">
        <button
          type="button"
          ref={cancelButtonRef}
          onClick={onCancel}
          disabled={isConfirming}
          className="industrial-button-secondary"
        >
          {resolvedCancelText}
        </button>
        <button
          type="button"
          ref={confirmButtonRef}
          onClick={onConfirm}
          disabled={isConfirming}
          className={type === 'warning' ? 'industrial-button-danger' : 'industrial-button-primary'}
        >
          {isConfirming && <Loader2 className="h-4 w-4 animate-spin" />}
          {resolvedConfirmText}
        </button>
      </div>
    </Modal>
  );
}
