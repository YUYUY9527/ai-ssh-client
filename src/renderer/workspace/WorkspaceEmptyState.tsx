import { lazy, Suspense, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Info,
  Plus,
  Server,
  Settings,
  Sparkles,
  Terminal,
  Upload,
} from 'lucide-react';
import type { SSHConnection } from '../../shared/types';
import { AppIcon } from '../components/AppIcon';
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
        <section className="workspace-hero">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="app-title-mark h-11 w-11 shrink-0">
              <AppIcon className="h-8 w-8" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-semibold tracking-tight text-fg">
                  {t('app.title')}
                </h1>
                <span
                  className="workspace-hero-badge"
                  title={`${t('workspace.home.quickStart')}: ${connections.length}`}
                  aria-label={`${t('workspace.home.quickStart')}: ${connections.length}`}
                >
                  <Terminal className="h-3 w-3" />
                  {connections.length}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-fg-muted">
                {t('app.subtitle')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              className="industrial-button-secondary px-3 py-1.5 text-xs"
              onClick={() => setImportOpen(true)}
            >
              <Upload className="h-3.5 w-3.5" />
              {t('workspace.home.importConnections')}
            </button>
            <button
              type="button"
              className="industrial-button-primary px-3.5 py-1.5 text-xs"
              onClick={onCreateConnection}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('workspace.home.newConnection')}
            </button>
          </div>
        </section>

        <div className="workspace-dashboard-top">
          <section className="industrial-card flex min-w-0 flex-col">
            <header className="workspace-home-panel-header rounded-t-[inherit]">
              <span className="flex items-center gap-2">
                <Server className="h-4 w-4 text-accent" />
                <h2>{t('workspace.home.quickStart')}</h2>
              </span>
              {connections.length > 0 && (
                <span className="rounded-full border border-line-subtle bg-surface-raised px-2 py-0.5 font-mono text-[10px] text-fg-muted tabular-nums">
                  {visibleConnections.length} / {connections.length}
                </span>
              )}
            </header>
            <div className="flex-1">
              {visibleConnections.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                  <span className="workspace-empty-card-icon workspace-empty-card-icon-connect h-11 w-11">
                    <Server className="h-5 w-5" />
                  </span>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-fg">
                      {t('workspace.home.noConnections')}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {t('workspace.home.noConnectionsHint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="industrial-button-primary mt-1 px-3.5 py-1.5 text-xs"
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
                        <span className="workspace-empty-card-icon workspace-empty-card-icon-connect transition-transform group-hover:scale-105">
                          <Server className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] font-semibold text-fg" title={connection.name}>
                              {connection.name}
                            </span>
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle opacity-0 transition-all group-hover:translate-x-0.5 group-hover:text-accent group-hover:opacity-100" />
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-muted" title={endpoint}>
                            {endpoint}
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="icon-button h-7 w-7 shrink-0 text-fg-subtle opacity-60 transition-opacity group-hover:opacity-100"
                        title={t('workspace.home.copyConnection')}
                        aria-label={t('workspace.home.copyConnection')}
                        onClick={() => {
                          void copyText(
                            `connection:${connection.id}`,
                            `ssh -p ${connection.port} ${connection.username}@${connection.host}`,
                          );
                        }}
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            {connections.length > visibleConnections.length && (
              <div className="border-t border-line-subtle px-4 py-2.5 text-[11px] text-fg-muted">
                {t('workspace.home.moreConnections', { count: connections.length - visibleConnections.length })}
              </div>
            )}
          </section>

          <section className="industrial-card flex min-w-0 flex-col">
            <header className="workspace-home-panel-header rounded-t-[inherit]">
              <span className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-fg-subtle" />
                <h2>{t('workspace.home.commonActions')}</h2>
              </span>
            </header>
            <div className="flex flex-col gap-1 p-2.5">
              <button type="button" className="workspace-home-action group" onClick={onCreateConnection}>
                <span className="workspace-empty-card-icon workspace-empty-card-icon-connect h-7 w-7">
                  <Plus className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 truncate">{t('workspace.home.newConnection')}</span>
                <ChevronRight className="h-3.5 w-3.5 text-fg-faint opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
              <button type="button" className="workspace-home-action group" onClick={() => setImportOpen(true)}>
                <span className="workspace-empty-card-icon h-7 w-7 border-line bg-surface-raised text-fg-muted">
                  <Upload className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 truncate">{t('workspace.home.importConnections')}</span>
                <ChevronRight className="h-3.5 w-3.5 text-fg-faint opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
              <button type="button" className="workspace-home-action group" onClick={() => onOpenSettings('terminal')}>
                <span className="workspace-empty-card-icon h-7 w-7 border-line bg-surface-raised text-fg-muted">
                  <Settings className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 truncate">{t('workspace.home.openSettings')}</span>
                <ChevronRight className="h-3.5 w-3.5 text-fg-faint opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
              <button type="button" className="workspace-home-action group" onClick={onOpenAssistant}>
                <span className="workspace-empty-card-icon workspace-empty-card-icon-ai h-7 w-7">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 truncate">{t('workspace.home.openAssistant')}</span>
                <ChevronRight className="h-3.5 w-3.5 text-fg-faint opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
            </div>
            <div className="workspace-home-hint mt-auto rounded-b-[inherit]">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
              <span>{t('workspace.home.connectionHint')}</span>
            </div>
          </section>
        </div>

        <section className="industrial-card">
          <div className="flex items-start gap-3.5 px-4 py-4">
            <span className="workspace-empty-card-icon workspace-empty-card-icon-ai mt-0.5 h-9 w-9">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="space-y-1">
                <h2 className="text-[13px] font-semibold text-fg">
                  {t('workspace.home.aiTitle')}
                </h2>
                <p className="text-xs leading-5 text-fg-muted">
                  {t('workspace.home.aiDescription')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-sunken py-0.5 pl-2.5 pr-1">
                  <span className="font-mono text-[11px] text-accent">$</span>
                  <code className="font-mono text-[11px] text-fg-secondary">
                    npm run mcp
                  </code>
                  <button
                    type="button"
                    className="icon-button h-6 w-6"
                    title={t('workspace.home.copyMcpCommand')}
                    aria-label={t('workspace.home.copyMcpCommand')}
                    onClick={() => {
                      void copyText('mcp-command', 'npm run mcp');
                    }}
                  >
                    {copiedKey === 'mcp-command' ? <Check className="h-3 w-3 text-accent" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
                <button
                  type="button"
                  className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-accent transition-colors hover:text-accent-hover"
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
