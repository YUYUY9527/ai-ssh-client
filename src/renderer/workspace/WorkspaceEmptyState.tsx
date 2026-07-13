import { Plug, Sparkles } from 'lucide-react';
import { AppIcon } from '../components/AppIcon';
import { useI18n } from '../i18n';

/** 无任何会话时展示的欢迎与引导面板 */
export function WorkspaceEmptyState() {
  const { t } = useI18n();

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--accent-primary)_40%,var(--border-color))] bg-[color-mix(in_srgb,var(--accent-primary)_12%,var(--bg-secondary))]">
        <AppIcon className="h-9 w-9" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          {t('workspace.empty.title')}
        </h2>
        <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">
          {t('workspace.empty.subtitle')}
        </p>
      </div>
      <div className="grid w-full max-w-md gap-2 sm:grid-cols-2">
        <div className="industrial-card flex items-start gap-3 p-3 text-left">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-teal-500/40 bg-teal-500/10 text-teal-500">
            <Plug className="h-4 w-4" />
          </span>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('workspace.empty.hintConnect')}
          </p>
        </div>
        <div className="industrial-card flex items-start gap-3 p-3 text-left">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-violet-500/40 bg-violet-500/10 text-violet-500">
            <Sparkles className="h-4 w-4" />
          </span>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('workspace.empty.hintAI')}
          </p>
        </div>
      </div>
    </div>
  );
}
