import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2, Pause, Play, RefreshCw, ScrollText, X } from 'lucide-react';
import { Modal } from '../shared-ui/Modal';
import { useI18n } from '../i18n';
import { getWebSftpClientId } from '../lib/web';
import { useSessionOverlay } from '../workspace/SessionOverlayContext';

interface SftpTailViewerModalProps {
  isOpen: boolean;
  connectionId: string;
  remotePath: string;
  initialMode?: 'tail' | 'chunk';
  onClose: () => void;
}

const CHUNK_SIZE = 65536;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 远端大文件分段浏览 + `tail -f` 实时追踪弹窗（支持超限大日志，不整文件载入内存）。 */
export function SftpTailViewerModal({
  isOpen,
  connectionId,
  remotePath,
  initialMode = 'tail',
  onClose,
}: SftpTailViewerModalProps) {
  const { t } = useI18n();
  const overlay = useSessionOverlay();
  const [mode, setMode] = useState<'tail' | 'chunk'>(initialMode);
  const [content, setContent] = useState('');
  const [totalBytes, setTotalBytes] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [search, setSearch] = useState('');
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setSearch('');
      setOffset(0);
      setFollowing(true);
      setError(null);
      setContent('');
    }
  }, [isOpen, remotePath, initialMode]);

  const loadChunk = useCallback(async (nextOffset: number) => {
    if (!window.electronAPI?.readSftpFileChunk) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.readSftpFileChunk(connectionId, {
        remotePath,
        mode: 'chunk',
        offset: nextOffset,
        length: CHUNK_SIZE,
      });
      if (!res.success) {
        setError(res.error || t('fileTransfer.tailLoadFailed'));
      } else {
        setContent(res.data.content || '');
        setTotalBytes(res.data.totalBytes || 0);
        setOffset(res.data.offset || 0);
        setHasMore(Boolean(res.data.hasMore));
        if (preRef.current) preRef.current.scrollTop = 0;
      }
    } finally {
      setLoading(false);
    }
  }, [connectionId, remotePath, t]);

  useEffect(() => {
    if (!isOpen || mode !== 'chunk') return;
    void loadChunk(offset);
  }, [isOpen, mode, offset, loadChunk]);

  // 实时 tail -f SSE 流
  useEffect(() => {
    if (!isOpen || mode !== 'tail' || !following) return undefined;
    setError(null);
    const params = new URLSearchParams({
      path: remotePath,
      lines: '300',
      clientId: getWebSftpClientId(),
    });
    const source = new EventSource(
      `/api/sftp/${encodeURIComponent(connectionId)}/tail/stream?${params.toString()}`,
    );
    let disposed = false;
    setContent('');
    source.addEventListener('data', (event) => {
      if (disposed) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (!payload?.text) return;
        setContent((prev) => {
          const next = prev + payload.text;
          return next.length > 512_000 ? next.slice(next.length - 512_000) : next;
        });
      } catch {
        // ignore
      }
    });
    source.addEventListener('error', (event) => {
      if (disposed) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { message?: string };
        if (payload?.message) setError(payload.message);
      } catch {
        // EventSource reconnect
      }
    });
    return () => {
      disposed = true;
      source.close();
    };
  }, [isOpen, mode, following, connectionId, remotePath]);

  useEffect(() => {
    if (mode === 'tail' && following && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [content, mode, following]);

  const visibleLines = useMemo(() => {
    if (!content) return [];
    const lines = content.split('\n');
    const needle = search.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((line) => line.toLowerCase().includes(needle));
  }, [content, search]);

  const handleDownloadSnapshot = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = remotePath.split('/').pop() || 'file.log';
    a.href = url;
    a.download = `${name}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="4xl"
      closeLabel={t('common.close')}
      panelClassName={
        overlay.container
          ? 'flex !h-[min(94%,860px)] !max-h-full flex-col !overflow-hidden'
          : 'flex !h-[min(90vh,860px)] !max-h-[min(90vh,860px)] flex-col !overflow-hidden'
      }
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <ScrollText className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate font-mono text-sm" title={remotePath}>{remotePath}</span>
        </span>
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line-subtle px-4 py-2 text-xs">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMode('tail')}
            className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
              mode === 'tail' ? 'bg-accent-muted text-accent' : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
            }`}
          >
            {t('fileTransfer.tailLiveMode')}
          </button>
          <button
            type="button"
            onClick={() => setMode('chunk')}
            className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
              mode === 'chunk' ? 'bg-accent-muted text-accent' : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
            }`}
          >
            {t('fileTransfer.tailChunkMode')}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative flex items-center">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('terminal.docker.logsSearchPlaceholder')}
              className="industrial-input h-7 w-40 pr-6 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="icon-button absolute right-1 h-5 w-5"
                aria-label={t('common.close')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {mode === 'tail' ? (
            <button
              type="button"
              onClick={() => setFollowing((v) => !v)}
              className={`industrial-button-secondary h-7 px-2 text-xs ${following ? 'text-accent' : ''}`}
            >
              {following ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              <span>{following ? t('terminal.docker.logsFollowing') : t('terminal.docker.logsPaused')}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={loading || offset <= 0}
                onClick={() => setOffset(0)}
                className="industrial-button-secondary h-7 px-2 text-xs"
              >
                {t('fileTransfer.tailFirst')}
              </button>
              <button
                type="button"
                disabled={loading || offset <= 0}
                onClick={() => setOffset((prev) => Math.max(0, prev - CHUNK_SIZE))}
                className="icon-button h-7 w-7"
                title={t('fileTransfer.tailPrev')}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={loading || !hasMore}
                onClick={() => setOffset((prev) => prev + CHUNK_SIZE)}
                className="icon-button h-7 w-7"
                title={t('fileTransfer.tailNext')}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={loading || totalBytes <= CHUNK_SIZE}
                onClick={() => setOffset(Math.max(0, totalBytes - CHUNK_SIZE))}
                className="industrial-button-secondary h-7 px-2 text-xs"
              >
                {t('fileTransfer.tailEnd')}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => { void loadChunk(offset); }}
                className="icon-button h-7 w-7"
                title={t('common.refresh')}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={handleDownloadSnapshot}
            className="industrial-button-secondary h-7 px-2 text-xs"
            title={t('terminal.docker.logsDownload')}
          >
            <Download className="h-3 w-3" />
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-danger-muted bg-danger-muted px-4 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}

      <pre
        ref={preRef}
        className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-primary)] p-3 font-mono text-[11px] leading-5 text-fg-secondary"
      >
        {loading && !content ? (
          <span className="inline-flex items-center gap-1.5 text-fg-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            {t('common.loading')}
          </span>
        ) : visibleLines.length === 0 ? (
          t('terminal.docker.logsEmpty')
        ) : (
          visibleLines.join('\n')
        )}
      </pre>

      <div className="flex shrink-0 items-center justify-between border-t border-line-subtle px-4 py-2 font-mono text-[11px] text-fg-muted">
        <span>
          {mode === 'chunk'
            ? `${formatBytes(offset)} – ${formatBytes(Math.min(totalBytes, offset + CHUNK_SIZE))} / ${formatBytes(totalBytes)}`
            : t('fileTransfer.tailStreamingHint')}
        </span>
        <button type="button" onClick={onClose} className="industrial-button-secondary px-3 py-1 text-xs">
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
