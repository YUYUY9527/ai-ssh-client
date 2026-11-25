import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search, Shield } from 'lucide-react';
import type { AuditLogEntry } from '../../shared/types';
import { useI18n } from '../i18n';
import { SettingsPage, SettingsSection } from '../settings/SettingsLayout';

const CATEGORIES = ['', 'auth', 'ssh', 'sftp', 'docker', 'port-forward', 'batch', 'settings', 'mcp'] as const;

/** 全局操作审计日志面板（查看 SSH/SFTP/Docker/端口转发/批量任务/鉴权等全部操作记录）。 */
export function AuditLogSettings() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [category, setCategory] = useState<string>('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    if (!window.electronAPI?.listAuditLogs) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.listAuditLogs({ category: category || undefined, search: search.trim() || undefined, limit: 200 });
      if (res.success) {
        setEntries(res.data.entries || []);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [category, search]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  return (
    <SettingsPage
      title={t('features.audit.title')}
      description={t('features.audit.description')}
    >
      <SettingsSection
        title={(
          <span className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5 text-accent" />
            {t('features.audit.records')} ({entries.length})
          </span>
        )}
        actions={(
          <button
            type="button"
            onClick={() => void loadLogs()}
            disabled={loading}
            className="industrial-button-secondary px-2.5 py-1 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </button>
        )}
      >
        <div className="space-y-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="industrial-input h-8 text-xs"
            >
              {CATEGORIES.map((cat) => (
                <option key={cat || 'all'} value={cat}>
                  {cat ? cat.toUpperCase() : t('features.audit.allCategories')}
                </option>
              ))}
            </select>
            <div className="relative flex-1 min-w-[180px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('features.audit.searchPlaceholder')}
                className="industrial-input h-8 w-full pl-8 text-xs"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-danger bg-danger-muted px-3 py-2 text-xs text-danger-fg">
              {error}
            </div>
          )}

          {loading ? (
            <p className="py-4 text-center text-xs text-fg-muted">{t('common.loading')}</p>
          ) : entries.length === 0 ? (
            <div className="rounded-md border border-dashed border-line-subtle px-3 py-6 text-center text-xs text-fg-muted">
              {t('features.audit.empty')}
            </div>
          ) : (
            <div className="max-h-[52vh] space-y-1.5 overflow-y-auto scrollbar-thin">
              {entries.map((entry, idx) => (
                <div key={`${entry.ts}-${idx}`} className="rounded-md border border-line-subtle bg-surface px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg-muted">
                        {entry.category}
                      </span>
                      <span className="font-mono font-medium text-fg">{entry.action}</span>
                      {entry.actor && (
                        <span className="text-[11px] text-fg-muted">by {entry.actor}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${
                        entry.outcome === 'ok'
                          ? 'bg-success-muted text-success-fg'
                          : entry.outcome === 'denied'
                            ? 'bg-warning-muted text-warning-fg'
                            : 'bg-danger-muted text-danger-fg'
                      }`}>
                        {entry.outcome}
                      </span>
                      <span className="font-mono text-[10px] text-fg-subtle">
                        {new Date(entry.ts).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  {(entry.target || entry.detail) && (
                    <div className="mt-1 truncate font-mono text-[11px] text-fg-muted">
                      {[entry.target, entry.detail].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
