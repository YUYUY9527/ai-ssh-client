import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export interface AppToast {
  id: string;
  title: string;
  body: string;
  type: 'success' | 'error';
}

interface ToastHostProps {
  toasts: AppToast[];
  onDismiss: (toastId: string) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** Hosts transient application notifications. */
export function ToastHost({ toasts, onDismiss, translate }: ToastHostProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="toast-host"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`toast-item ${
            toast.type === 'success' ? 'toast-item-success' : 'toast-item-error'
          }`}
        >
          <div className="flex items-start gap-2">
            {toast.type === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{toast.title}</div>
              <div className="mt-0.5 break-words text-xs opacity-80" title={toast.body}>
                {toast.body}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="icon-button h-6 w-6 opacity-70 hover:opacity-100"
              aria-label={translate('common.close')}
              title={translate('common.close')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
