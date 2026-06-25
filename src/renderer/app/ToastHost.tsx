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
    <div className="fixed right-4 top-16 z-[70] w-[min(22rem,calc(100vw-2rem))] space-y-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`industrial-card border px-3 py-2 shadow-lg ${
            toast.type === 'success'
              ? 'border-green-500/30 bg-green-50 text-green-800 dark:bg-green-950/70 dark:text-green-200'
              : 'border-red-500/30 bg-red-50 text-red-800 dark:bg-red-950/70 dark:text-red-200'
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
              <div className="mt-0.5 truncate text-xs opacity-80" title={toast.body}>
                {toast.body}
              </div>
            </div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="rounded-sm p-0.5 opacity-70 transition-opacity hover:opacity-100"
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
