import { useCallback, useEffect, useRef, useState } from 'react';
import { File, Folder, Loader2, Search, X } from 'lucide-react';
import type { SftpSearchMode, SftpSearchResultItem } from '../../shared/ipc-types';

interface RemoteSearchPanelProps {
  connectionId: string;
  /** 搜索根目录（当前浏览路径）。 */
  currentPath: string;
  /** 点击结果后跳转到目标目录。 */
  onNavigate: (path: string) => void;
  onClose: () => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** 取 posix 路径的父目录；目录结果则进入其自身。 */
function targetDirFor(item: SftpSearchResultItem): string {
  if (item.isDirectory) return item.path;
  const idx = item.path.lastIndexOf('/');
  return idx > 0 ? item.path.slice(0, idx) : '/';
}

/**
 * 远程文件搜索弹层：在当前目录下按文件名或文件内容递归搜索（服务端
 * find/grep，独立 SSH 通道），点击结果跳转到所在目录。仅 Web 端可用。
 */
export function RemoteSearchPanel({ connectionId, currentPath, onNavigate, onClose, translate }: RemoteSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SftpSearchMode>('name');
  const [results, setResults] = useState<SftpSearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const requestSeq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  const runSearch = useCallback(async () => {
    const api = window.electronAPI?.searchSftpFiles;
    const trimmed = query.trim();
    if (!api || !trimmed) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api(connectionId, { path: currentPath, query: trimmed, mode, limit: 200 });
      if (seq !== requestSeq.current) return;
      if (result.success && result.data) {
        setResults(result.data.results);
        setSearched(true);
      } else {
        setResults([]);
        setError(result.success ? translate('features.search.failed') : (result.error || translate('features.search.failed')));
      }
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setResults([]);
      setError(err instanceof Error ? err.message : translate('features.search.failed'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [connectionId, currentPath, query, mode, translate]);

  return (
    <div
      ref={panelRef}
      className="app-popover left-2 top-full z-popover mt-1 flex max-h-[min(28rem,calc(100vh-8rem))] w-[min(380px,calc(100vw-16px))] flex-col overflow-hidden"
      data-remote-search-panel
    >
      <div className="shrink-0 space-y-2 border-b border-[color-mix(in_srgb,var(--border-color)_65%,transparent)] p-3 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-fg">
            <Search className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate">{translate('features.search.title')}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="icon-button h-6 w-6 shrink-0"
            title={translate('common.close')}
            aria-label={translate('common.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(); } }}
            placeholder={translate('features.search.placeholder')}
            aria-label={translate('features.search.placeholder')}
            className="industrial-input min-w-0 flex-1 py-1.5 text-sm"
            data-remote-search-input
          />
          <button
            type="button"
            onClick={() => { void runSearch(); }}
            disabled={loading || !query.trim()}
            className="icon-button h-8 w-8 shrink-0"
            title={translate('common.search')}
            aria-label={translate('common.search')}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Search className="h-4 w-4" />}
          </button>
        </div>

        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setMode('name')}
            className={`shrink-0 rounded px-2 py-0.5 transition-colors ${mode === 'name' ? 'bg-accent-muted font-medium text-accent dark:text-accent-hover' : 'text-fg-muted hover:bg-surface-hover'}`}
          >
            {translate('features.search.byName')}
          </button>
          <button
            type="button"
            onClick={() => setMode('content')}
            className={`shrink-0 rounded px-2 py-0.5 transition-colors ${mode === 'content' ? 'bg-accent-muted font-medium text-accent dark:text-accent-hover' : 'text-fg-muted hover:bg-surface-hover'}`}
          >
            {translate('features.search.byContent')}
          </button>
          <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-fg-subtle" title={currentPath}>
            {currentPath}
          </span>
        </div>

        {error && <p className="break-words text-xs text-danger-fg">{error}</p>}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-5 text-xs text-fg-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            <span>{translate('features.search.searching')}</span>
          </div>
        )}
        {!loading && searched && results.length === 0 && !error && (
          <p className="px-1 py-5 text-center text-xs text-fg-muted">{translate('features.search.noResults')}</p>
        )}
        {!loading && results.map((item) => (
          <button
            key={item.path}
            type="button"
            onClick={() => { onNavigate(targetDirFor(item)); onClose(); }}
            className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
            title={translate('features.search.openLocation')}
          >
            {item.isDirectory
              ? <Folder className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              : <File className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{item.name}</span>
              <span className="block truncate font-mono text-[11px] text-fg-subtle">{item.path}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}