import { AlertTriangle, Info } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: 'warning' | 'info';
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  type = 'warning',
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();

  const resolvedConfirmText = confirmText ?? t('common.confirm');
  const resolvedCancelText = cancelText ?? t('common.cancel');

  // 自动聚焦到确认按钮
  useEffect(() => {
    if (isOpen && confirmButtonRef.current) {
      confirmButtonRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* 对话框 */}
      <div className="relative bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6 animate-in fade-in zoom-in-95 duration-200">
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-4">
          {type === 'warning' ? (
            <AlertTriangle className="w-6 h-6 text-orange-500" />
          ) : (
            <Info className="w-6 h-6 text-blue-500" />
          )}
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
            {title}
          </h3>
        </div>

        {/* 消息 */}
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-6">
          {message}
        </p>

        {/* 按钮 */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300
                     bg-slate-100 dark:bg-slate-700 rounded-md
                     hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            {resolvedCancelText}
          </button>
          <button
            ref={confirmButtonRef}
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium text-white
                     bg-blue-600 rounded-md
                     hover:bg-blue-500 transition-colors"
          >
            {resolvedConfirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
