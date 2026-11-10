import { lazy, Suspense, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Copy,
  Info,
  Plus,
  Server,
  Settings,
  Sparkles,
  Upload,
} from 'lucide-react';
import type { SSHConnection } from '../../shared/types';
import { sortConnectionsByRecent } from '../connection/recent-connections';
import { useI18n } from '../i18n';
import { useAIStore } from '../store/useAIStore';
import { useConnectionStore } from '../store/useConnectionStore';

const ConnectionImportExportModal = lazy(async () => {
  const module = await import('../connection/ConnectionImportExportModal');
  return { default: module.ConnectionImportExportModal };
});

export type WorkspaceHomeSettingsTab =
  | 'terminal'
  | 'ssh'
  | 'providers'
  | 'agent'
  | 'mcp'
  | 'language'
  | 'password';

interface WorkspaceEmptyStateProps {
  connections: SSHConnection[];
  onConnect: (connectionId: string, connectionName: string) => void;
  onCreateConnection: () => void;
  onOpenSettings: (tab: WorkspaceHomeSettingsTab) => void;
  onOpenAssistant: () => void;
}

/** 无任何会话时展示的首页仪表盘 */
export function WorkspaceEmptyState({
  connections,
  onConnect,
  onCreateConnection,
  onOpenSettings,
  onOpenAssistant,
}: WorkspaceEmptyStateProps) {
  const { t } = useI18n();
  const [importOpen, setImportOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const recentConnectionIds = useConnectionStore((state) => state.recentConnectionIds);

  const visibleConnections = useMemo(
    () => sortConnectionsByRecent(connections, recentConnectionIds).slice(0, 5),
    [connections, recentConnectionIds],
  );
  const isWeb = typeof window !== 'undefined' && window.__AISSH_WEB__ === true;
  const aiSettingsTab: WorkspaceHomeSettingsTab = isWeb ? 'mcp' : 'providers';

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      // 浏览器可能限制剪贴板权限，保留原按钮状态即可。
    }
  };

  return (
    <div className="workspace-dashboard">
      <div className="workspace-dashboard-inner">
        <div className="workspace-dashboard-top">
          <section className="industrial-card flex min-w-0 flex-col overflow-hidden">
            <header className="workspace-home-panel-header">
              <Server className="h-4 w-4 text-teal-500" />
              <h2>{t('workspace.home.quickStart')}</h2>
            </header>
            <div className="flex-1">
              {visibleConnections.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-6 py-9 text-center">
                  <span className="workspace-empty-card-icon workspace-empty-card-icon-connect h-10 w-10">
                    <Server className="h-5 w-5" />
                  </span>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {t('workspace.home.noConnections')}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t('workspace.home.noConnectionsHint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="industrial-button-primary px-3 py-1.5 text-xs"
                    onClick={onCreateConnection}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('workspace.home.newConnection')}
                  </button>
                </div>
              ) : (
                visibleConnections.map((connection) => {
                  const endpoint = `${connection.username}@${connection.host}:${connection.port}`;
                  const copied = copiedKey === `connection:${connection.id}`;
                  return (
                    <div key={connection.id} className="workspace-home-row group">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => onConnect(connection.id, connection.name)}
                      >
                        <span className="workspace-empty-card-icon workspace-empty-card-icon-connect">
                          <Server className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                            {connection.name}
                          </div>
                          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                            {endpoint}
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="icon-button h-7 w-7 shrink-0 text-slate-400 opacity-70 transition-opacity hover:opacity-100"
                        title={t('workspace.home.copyConnection')}
                        aria-label={t('workspace.home.copyConnection')}
                        onClick={() => {
                          void copyText(
                            `connection:${connection.id}`,
                            `ssh -p ${connection.port} ${connection.username}@${connection.host}`,
                          );
                        }}
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-teal-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            {connections.length > visibleConnections.length && (
              <div className="px-4 pb-3 text-[11px] text-slate-500 dark:text-slate-400">
                {t('workspace.home.moreConnections', { count: connections.length - visibleConnections.length })}
              </div>
            )}
          </section>

          <section className="industrial-card flex min-w-0 flex-col overflow-hidden">
            <header className="workspace-home-panel-header">
              <Settings className="h-4 w-4 text-slate-400" />
              <h2>{t('workspace.home.commonActions')}</h2>
            </header>
            <div className="flex flex-col gap-1 p-2">
              <button type="button" className="workspace-home-action" onClick={onCreateConnection}>
                <Plus className="h-4 w-4" />
                {t('workspace.home.newConnection')}
              </button>
              <button type="button" className="workspace-home-action" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4" />
                {t('workspace.home.importConnections')}
              </button>
              <button type="button" className="workspace-home-action" onClick={() => onOpenSettings('terminal')}>
                <Settings className="h-4 w-4" />
                {t('workspace.home.openSettings')}
              </button>
              <button type="button" className="workspace-home-action" onClick={onOpenAssistant}>
                <Sparkles className="h-4 w-4" />
                {t('workspace.home.openAssistant')}
              </button>
            </div>
            <div className="workspace-home-hint">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('workspace.home.connectionHint')}</span>
            </div>
          </section>
        </div>

        <section className="industrial-card overflow-hidden">
          <div className="flex items-start gap-3 px-4 py-4">
            <span className="workspace-empty-card-icon workspace-empty-card-icon-ai mt-0.5">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {t('workspace.home.aiTitle')}
                </h2>
                <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {t('workspace.home.aiDescription')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-sm border border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-secondary)_70%,transparent)] px-2 py-1 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                  npm run mcp
                </code>
                <button
                  type="button"
                  className="icon-button h-7 w-7"
                  title={t('workspace.home.copyMcpCommand')}
                  aria-label={t('workspace.home.copyMcpCommand')}
                  onClick={() => {
                    void copyText('mcp-command', 'npm run mcp');
                  }}
                >
                  {copiedKey === 'mcp-command' ? <Check className="h-3.5 w-3.5 text-teal-500" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  className="ml-1 inline-flex items-center gap-1 text-xs text-teal-600 transition-colors hover:text-teal-500 dark:text-teal-400"
                  onClick={() => onOpenSettings(aiSettingsTab)}
                >
                  {t('workspace.home.learnMore')}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {importOpen && (
        <Suspense fallback={null}>
          <ConnectionImportExportModal
            isOpen
            mode="import"
            existingConnections={connections}
            onClose={() => setImportOpen(false)}
            onImported={async () => {
              await Promise.all([
                useConnectionStore.getState().loadConnections(),
                useAIStore.getState().loadProviders(),
              ]);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
