import { useCallback, useRef, useState } from 'react';
import { File, Folder, Search, X } from 'lucide-react';
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
  const inputRef = useRef<HTMLInputElement>(null);

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
      className="app-popover right-0 top-full mt-1 w-[380px] p-3 space-y-2 z-50"
      data-remote-search-panel
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Search className="w-4 h-4 text-teal-500" />
          {translate('features.search.title')}
        </span>
        <button type="button" onClick={onClose} className="icon-button h-6 w-6" title={translate('common.close')}>
          <X className="w-3.5 h-3.5" />
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
          className="flex-1 min-w-0 px-2 py-1.5 text-sm rounded-md border border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-transparent text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-teal-500"
          data-remote-search-input
        />
        <button
          type="button"
          onClick={() => { void runSearch(); }}
          disabled={loading || !query.trim()}
          className="icon-button h-8 w-8 shrink-0"
          title={translate('common.search')}
        >
          <Search className={`w-4 h-4 ${loading ? 'animate-pulse' : ''}`} />
        </button>
      </div>

      <div className="flex items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => setMode('name')}
          className={`px-2 py-0.5 rounded ${mode === 'name' ? 'bg-teal-500/15 text-teal-600 dark:text-teal-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
        >
          {translate('features.search.byName')}
        </button>
        <button
          type="button"
          onClick={() => setMode('content')}
          className={`px-2 py-0.5 rounded ${mode === 'content' ? 'bg-teal-500/15 text-teal-600 dark:text-teal-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
        >
          {translate('features.search.byContent')}
        </button>
        <span className="ml-auto text-slate-400 dark:text-slate-500 truncate" title={currentPath}>{currentPath}</span>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="max-h-[300px] overflow-y-auto -mx-1">
        {loading && (
          <p className="text-xs text-slate-400 dark:text-slate-500 px-1 py-3">{translate('features.search.searching')}</p>
        )}
        {!loading && searched && results.length === 0 && !error && (
          <p className="text-xs text-slate-400 dark:text-slate-500 px-1 py-3">{translate('features.search.noResults')}</p>
        )}
        {!loading && results.map((item) => (
          <button
            key={item.path}
            type="button"
            onClick={() => { onNavigate(targetDirFor(item)); onClose(); }}
            className="w-full flex items-start gap-2 px-1.5 py-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
            title={translate('features.search.openLocation')}
          >
            {item.isDirectory
              ? <Folder className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
              : <File className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />}
            <span className="min-w-0">
              <span className="block text-sm text-slate-800 dark:text-slate-100 truncate">{item.name}</span>
              <span className="block text-[11px] text-slate-400 dark:text-slate-500 truncate">{item.path}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}