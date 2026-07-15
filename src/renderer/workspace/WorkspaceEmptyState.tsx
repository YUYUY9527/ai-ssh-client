import { Plug, Sparkles } from 'lucide-react';
import { AppIcon } from '../components/AppIcon';
import { useI18n } from '../i18n';

/** 无任何会话时展示的欢迎与引导面板 */
export function WorkspaceEmptyState() {
  const { t } = useI18n();

  return (
    <div className="workspace-empty">
      <div className="workspace-empty-mark">
        <AppIcon className="h-9 w-9" />
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">
          {t('workspace.empty.title')}
        </h2>
        <p className="mx-auto max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">
          {t('workspace.empty.subtitle')}
        </p>
      </div>
      <div className="grid w-full max-w-lg gap-3 sm:grid-cols-2">
        <div className="industrial-card flex items-start gap-3 p-4 text-left">
          <span className="workspace-empty-card-icon workspace-empty-card-icon-connect">
            <Plug className="h-4 w-4" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
              {t('connection.connect')}
            </p>
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              {t('workspace.empty.hintConnect')}
            </p>
          </div>
        </div>
        <div className="industrial-card flex items-start gap-3 p-4 text-left">
          <span className="workspace-empty-card-icon workspace-empty-card-icon-ai">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
              AI
            </p>
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              {t('workspace.empty.hintAI')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
