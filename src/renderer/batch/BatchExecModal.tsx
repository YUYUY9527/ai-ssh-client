import { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Download,
  Layers,
  Loader2,
  Play,
  Server,
  Terminal,
  Upload,
  XCircle,
} from 'lucide-react';
import type { ConnectionGroup, SSHConnection } from '../../shared/types';
import type { BatchCommandResultItem, BatchDistributeResultItem } from '../../shared/ipc-types';
import { Modal } from '../shared-ui/Modal';
import { IndustrialSelect } from '../shared-ui/IndustrialSelect';

interface BatchExecModalProps {
  isOpen: boolean;
  connections: SSHConnection[];
  groups: ConnectionGroup[];
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

/**
 * 多机批量任务执行与文件分发弹窗：
 * - 通过通用 <Modal scope="global" /> 挂载到 document.body，避免被顶栏 backdrop-filter 裁剪
 * - 左侧按分组 / 标签筛选并勾选目标主机，右侧配置并发/超时、执行命令或分发文件并查看汇总结果
 */
export function BatchExecModal({
  isOpen,
  connections,
  groups,
  translate,
  onClose,
}: BatchExecModalProps) {
  const [mode, setMode] = useState<'exec' | 'distribute'>('exec');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [command, setCommand] = useState('');
  const [remotePath, setRemotePath] = useState('/tmp/');
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number; base64: string } | null>(null);
  const [concurrency, setConcurrency] = useState(5);
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [execResults, setExecResults] = useState<BatchCommandResultItem[] | null>(null);
  const [distResults, setDistResults] = useState<BatchDistributeResultItem[] | null>(null);

  const visibleConnections = useMemo(() => {
    if (groupFilter === 'all') return connections;
    if (groupFilter === 'ungrouped') return connections.filter((c) => !c.groupId);
    if (groupFilter.startsWith('tag:')) {
      const tag = groupFilter.slice(4);
      return connections.filter((c) => c.tags?.includes(tag));
    }
    return connections.filter((c) => c.groupId === groupFilter);
  }, [connections, groupFilter]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      for (const tag of c.tags || []) set.add(tag);
    }
    return Array.from(set).sort();
  }, [connections]);

  const filterOptions = useMemo(() => ([
    { value: 'all', label: translate('features.batch.allHosts') },
    { value: 'ungrouped', label: translate('features.connectionGroups.ungrouped') },
    ...groups.map((g) => ({ value: g.id, label: g.name })),
    ...allTags.map((tag) => ({ value: `tag:${tag}`, label: `#${tag}` })),
  ]), [groups, allTags, translate]);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const c of visibleConnections) next.add(c.id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
      setFileInfo({ name: file.name, size: file.size, base64 });
      if (remotePath.endsWith('/')) {
        setRemotePath(`${remotePath}${file.name}`);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRun = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setRunning(true);
    setError(null);
    setExecResults(null);
    setDistResults(null);
    try {
      if (mode === 'exec') {
        if (!window.electronAPI?.runBatchCommand) {
          setError('Batch exec API unavailable');
          return;
        }
        const res = await window.electronAPI.runBatchCommand({
          connectionIds: ids,
          command,
          concurrency,
          timeoutMs: timeoutSec * 1000,
        });
        if (!res.success) setError(res.error);
        else setExecResults(res.data.results);
      } else {
        if (!window.electronAPI?.runBatchDistribute || !fileInfo) {
          setError('Batch distribute API unavailable or file missing');
          return;
        }
        const res = await window.electronAPI.runBatchDistribute({
          connectionIds: ids,
          remotePath,
          contentBase64: fileInfo.base64,
          concurrency,
          timeoutMs: timeoutSec * 1000,
        });
        if (!res.success) setError(res.error);
        else setDistResults(res.data.results);
      }
    } finally {
      setRunning(false);
    }
  };

  const exportMarkdown = () => {
    const lines: string[] = [];
    if (execResults) {
      lines.push('# Batch Command Report', '', `Command: \`${command}\``, '');
      for (const r of execResults) {
        lines.push(`## ${r.name} (${r.host}) — ${r.ok ? 'OK' : 'FAILED'} (exit ${r.exitCode ?? '-'}, ${r.durationMs}ms)`);
        if (r.stdout) lines.push('```', r.stdout.trim(), '```');
        if (r.stderr || r.error) lines.push('```', (r.stderr || r.error || '').trim(), '```');
        lines.push('');
      }
    } else if (distResults) {
      lines.push('# Batch File Distribution Report', '', `Remote path: \`${remotePath}\``, '');
      for (const r of distResults) {
        lines.push(`- **${r.name}** (${r.host}): ${r.ok ? `OK (${r.bytes} bytes, ${r.durationMs}ms)` : `FAILED — ${r.error}`}`);
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `batch-report-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const canRun = !running
    && selectedIds.size > 0
    && (mode === 'exec' ? command.trim().length > 0 : Boolean(fileInfo && remotePath.trim()));

  const resultSummary = useMemo(() => {
    const list = execResults ?? distResults;
    if (!list) return null;
    const okCount = list.filter((item) => item.ok).length;
    return { total: list.length, okCount, failCount: list.length - okCount };
  }, [execResults, distResults]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      scope="global"
      size="3xl"
      closeLabel={translate('common.close')}
      title={(
        <span className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-muted text-accent">
            <Layers className="h-3.5 w-3.5" />
          </span>
          <span>{translate('features.batch.title')}</span>
        </span>
      )}
      panelClassName="flex h-[min(82vh,44rem)] flex-col overflow-hidden"
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-line-subtle md:grid-cols-[272px_minmax(0,1fr)] md:divide-x md:divide-y-0">
        {/* 左侧：目标主机选择 */}
        <div className="flex min-h-0 flex-col bg-surface-sunken p-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-fg">
                {translate('features.batch.targets')}
              </span>
              <span className="rounded-full bg-accent-muted px-1.5 py-0.5 font-mono text-[10.5px] font-medium leading-none text-accent tabular-nums">
                {selectedIds.size}/{visibleConnections.length}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-medium">
              <button
                type="button"
                onClick={selectAllVisible}
                className="text-accent transition-colors hover:underline"
              >
                {translate('features.batch.selectAll')}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="text-fg-muted transition-colors hover:text-fg hover:underline"
              >
                {translate('features.batch.clear')}
              </button>
            </div>
          </div>

          <div className="mb-2.5">
            <IndustrialSelect
              value={groupFilter}
              options={filterOptions}
              onChange={setGroupFilter}
              className="w-full"
            />
          </div>

          <div className="scrollbar-modern min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
            {visibleConnections.map((conn) => {
              const checked = selectedIds.has(conn.id);
              return (
                <button
                  key={conn.id}
                  type="button"
                  onClick={() => toggleId(conn.id)}
                  aria-pressed={checked}
                  className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
                    checked
                      ? 'border-accent bg-accent-muted/70'
                      : 'border-line-subtle bg-surface hover:border-line hover:bg-surface-hover'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      checked
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-line bg-surface-sunken text-transparent'
                    }`}
                    aria-hidden="true"
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  <Server className={`h-3.5 w-3.5 shrink-0 ${checked ? 'text-accent' : 'text-fg-subtle'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium leading-tight text-fg">
                      {conn.name}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] leading-tight text-fg-muted">
                      {conn.username}@{conn.host}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 右侧：任务配置与执行结果 */}
        <div className="scrollbar-modern flex min-h-0 flex-col gap-3.5 overflow-y-auto bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line-subtle pb-3">
            <div className="toolbar-group">
              <button
                type="button"
                onClick={() => setMode('exec')}
                className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  mode === 'exec'
                    ? 'bg-accent-muted text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
                }`}
              >
                <Terminal className="h-3.5 w-3.5" />
                {translate('features.batch.modeExec')}
              </button>
              <button
                type="button"
                onClick={() => setMode('distribute')}
                className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  mode === 'distribute'
                    ? 'bg-accent-muted text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                {translate('features.batch.modeDistribute')}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-fg-secondary">
              <label className="flex items-center gap-1.5">
                <span className="text-fg-muted">{translate('features.batch.concurrency')}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
                  className="industrial-input h-7 w-14 px-2 py-0.5 text-center font-mono text-xs tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-fg-muted">{translate('features.batch.timeoutSec')}</span>
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={timeoutSec}
                  onChange={(e) => setTimeoutSec(Math.max(5, Math.min(300, Number(e.target.value) || 30)))}
                  className="industrial-input h-7 w-16 px-2 py-0.5 text-center font-mono text-xs tabular-nums"
                />
              </label>
            </div>
          </div>

          {mode === 'exec' ? (
            <div className="space-y-1.5">
              <label className="industrial-field-label">{translate('features.batch.modeExec')}</label>
              <textarea
                rows={4}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={translate('features.batch.commandPlaceholder')}
                className="industrial-input w-full resize-y font-mono text-xs leading-relaxed text-fg"
                spellCheck={false}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="industrial-field-label">{translate('features.batch.chooseFile')}</label>
                <label className="industrial-button-secondary inline-flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs">
                  <Upload className="h-3.5 w-3.5 text-accent" />
                  <span className="text-fg">
                    {fileInfo ? `${fileInfo.name} (${fileInfo.size} B)` : translate('features.batch.chooseFile')}
                  </span>
                  <input type="file" className="hidden" onChange={handleFileChange} />
                </label>
              </div>
              <div className="space-y-1.5">
                <label className="industrial-field-label">Remote Path</label>
                <input
                  type="text"
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                  placeholder="/tmp/deploy.conf"
                  className="industrial-input w-full font-mono text-xs text-fg"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={!canRun}
                onClick={() => void handleRun()}
                className="industrial-button-primary px-3.5 py-1.5 text-xs"
              >
                {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                <span>{running ? translate('features.batch.running') : translate('features.batch.run')}</span>
              </button>
              {resultSummary && (
                <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
                  <span className="text-success-fg">✓ {resultSummary.okCount}</span>
                  {resultSummary.failCount > 0 && (
                    <span className="text-danger-fg">✗ {resultSummary.failCount}</span>
                  )}
                  <span className="text-fg-subtle">/ {resultSummary.total}</span>
                </span>
              )}
            </div>

            {(execResults || distResults) && (
              <button
                type="button"
                onClick={exportMarkdown}
                className="industrial-button-secondary px-2.5 py-1.5 text-xs"
              >
                <Download className="h-3.5 w-3.5" />
                {translate('features.batch.exportReport')}
              </button>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-danger bg-danger-muted px-3 py-2 text-xs text-danger-fg">
              {error}
            </div>
          )}

          {execResults && (
            <div className="space-y-2">
              {execResults.map((item) => (
                <details
                  key={item.connectionId}
                  open={!item.ok || execResults.length <= 4}
                  className="overflow-hidden rounded-md border border-line-subtle bg-surface-sunken"
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-2 bg-surface px-3 py-2 text-xs hover:bg-surface-hover">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.ok
                        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                        : <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />}
                      <span className="truncate font-semibold text-fg">{item.name}</span>
                      <span className="truncate font-mono text-[11px] text-fg-muted">{item.host}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5 font-mono text-[11px] text-fg-muted tabular-nums">
                      <span className={item.ok ? 'text-success-fg' : 'text-danger-fg'}>
                        exit {item.exitCode ?? '-'}
                      </span>
                      <span>{item.durationMs}ms</span>
                    </div>
                  </summary>
                  <div className="space-y-1.5 border-t border-line-subtle p-3 font-mono text-[11.5px] leading-relaxed">
                    {item.stdout && (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-fg-secondary">
                        {item.stdout}
                      </pre>
                    )}
                    {(item.stderr || item.error) && (
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-danger-fg">
                        {item.stderr || item.error}
                      </pre>
                    )}
                    {!item.stdout && !item.stderr && !item.error && (
                      <span className="text-fg-subtle">(no output)</span>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}

          {distResults && (
            <div className="space-y-1.5">
              {distResults.map((item) => (
                <div
                  key={item.connectionId}
                  className="flex items-center justify-between gap-2 rounded-md border border-line-subtle bg-surface-sunken px-3 py-2 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {item.ok
                      ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                      : <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />}
                    <span className="truncate font-semibold text-fg">{item.name}</span>
                    <span className="truncate font-mono text-[11px] text-fg-muted">{item.host}</span>
                  </div>
                  <span className={`font-mono text-[11px] tabular-nums ${item.ok ? 'text-success-fg' : 'text-danger-fg'}`}>
                    {item.ok ? `${item.bytes} B · ${item.durationMs}ms` : item.error}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
