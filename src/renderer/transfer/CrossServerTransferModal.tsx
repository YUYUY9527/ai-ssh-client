import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  CornerLeftUp,
  File as FileIcon,
  Folder,
  Home,
  Loader2,
  RefreshCw,
  Server,
} from 'lucide-react';

import type { SftpConflictPolicy } from '../../shared/ipc-types';
import { useI18n } from '../i18n';
import { useSessionStore } from '../session/useSessionStore';
import { Modal } from '../shared-ui/Modal';
import { useConnectionStore } from '../store/useConnectionStore';
import { useSftpTransferStore } from '../store/useSftpTransferStore';
import { DEFAULT_REMOTE_PATH, type RemoteFileItem } from './transfer-types';

type CrossServerConflictPolicy = Exclude<SftpConflictPolicy, 'ask'>;

interface CrossServerTransferModalProps {
  isOpen: boolean;
  sourceConnectionId: string;
  sourceFile: RemoteFileItem;
  onClose: () => void;
  onStarted: (targetServerName: string) => void;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function parentPosixPath(remotePath: string): string {
  const trimmed = remotePath.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/' || trimmed === '~') return '/';
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** 跨服务器文件传输弹窗：把当前已连接 A 服务器的文件直接流式传输到已连接 B 服务器的指定目录。 */
export function CrossServerTransferModal({
  isOpen,
  sourceConnectionId,
  sourceFile,
  onClose,
  onStarted,
}: CrossServerTransferModalProps) {
  const { t } = useI18n();
  const sessions = useSessionStore((state) => state.sessions);
  const connections = useConnectionStore((state) => state.connections);
  const browserByConnection = useSftpTransferStore((state) => state.browserByConnection);

  const sourceSession = sessions[sourceConnectionId];
  const sourceConnection = useMemo(
    () => connections.find((item) => item.id === (sourceSession?.connectionId || sourceConnectionId)),
    [connections, sourceSession?.connectionId, sourceConnectionId],
  );
  const sourceLabel = sourceSession?.title || sourceConnection?.name || sourceConnectionId;

  const connectedTargets = useMemo(() => {
    const connMap = new Map(connections.map((item) => [item.id, item]));
    return Object.values(sessions)
      .filter((session) => session.state === 'connected' && session.id !== sourceConnectionId)
      .map((session) => {
        const conn = connMap.get(session.connectionId) ?? connMap.get(session.id);
        return {
          id: session.id,
          name: session.title || conn?.name || session.id,
          endpoint: conn ? `${conn.username}@${conn.host}:${conn.port}` : '',
          defaultDir: browserByConnection[session.id]?.remotePath || session.cwd || DEFAULT_REMOTE_PATH,
        };
      });
  }, [sessions, connections, browserByConnection, sourceConnectionId]);

  const [targetConnectionId, setTargetConnectionId] = useState<string>('');
  const [targetDirectory, setTargetDirectory] = useState<string>(DEFAULT_REMOTE_PATH);
  const [targetName, setTargetName] = useState<string>(sourceFile.name);
  const [conflictPolicy, setConflictPolicy] = useState<CrossServerConflictPolicy>('overwrite');
  const [folders, setFolders] = useState<RemoteFileItem[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const listReqRef = useRef(0);

  // 打开弹窗或源文件变更时初始化默认目标服务器与文件名
  useEffect(() => {
    if (!isOpen) return;
    setTargetName(sourceFile.name);
    setSubmitError(null);
    setFoldersError(null);
    setTargetConnectionId((current) => {
      if (current && connectedTargets.some((item) => item.id === current)) {
        return current;
      }
      return connectedTargets[0]?.id ?? '';
    });
  }, [isOpen, sourceFile.name, sourceFile.path, connectedTargets]);

  const loadTargetFolders = useCallback(async (connId: string, dirPath: string) => {
    const api = window.electronAPI?.listDirectory;
    if (!api || !connId) return;
    const reqId = ++listReqRef.current;
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const result = await api(connId, dirPath || DEFAULT_REMOTE_PATH);
      if (reqId !== listReqRef.current) return;
      if (result.success && result.data) {
        const resolved = result.data.path || dirPath || DEFAULT_REMOTE_PATH;
        setTargetDirectory(resolved);
        const dirs = (result.data.files || []).filter((item: RemoteFileItem) => item.isDirectory);
        setFolders(dirs);
      } else {
        setFolders([]);
        setFoldersError(result.success ? t('fileTransfer.crossServer.loadFoldersFailed') : (result.error || t('fileTransfer.crossServer.loadFoldersFailed')));
      }
    } catch (caught) {
      if (reqId !== listReqRef.current) return;
      setFolders([]);
      setFoldersError(caught instanceof Error ? caught.message : t('fileTransfer.crossServer.loadFoldersFailed'));
    } finally {
      if (reqId === listReqRef.current) {
        setFoldersLoading(false);
      }
    }
  }, [t]);

  // 切换目标服务器时，自动定位到目标服务器当前的 SFTP 路径或工作目录并拉取子目录
  useEffect(() => {
    if (!isOpen || !targetConnectionId) {
      setFolders([]);
      return;
    }
    const target = connectedTargets.find((item) => item.id === targetConnectionId);
    const initialDir = target?.defaultDir || DEFAULT_REMOTE_PATH;
    setTargetDirectory(initialDir);
    void loadTargetFolders(targetConnectionId, initialDir);
    // 仅在弹窗打开或目标服务器切换时自动加载初始目录，避免目标路径变化反向触发重复拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, targetConnectionId]);

  const selectedTarget = connectedTargets.find((item) => item.id === targetConnectionId) ?? null;

  const handleSubmit = async () => {
    if (submitting || !selectedTarget) return;
    const trimmedName = targetName.trim() || sourceFile.name;
    if (
      !trimmedName
      || trimmedName === '.'
      || trimmedName === '..'
      || trimmedName.includes('/')
      || trimmedName.includes('\\')
    ) {
      setSubmitError(t('fileTransfer.crossServer.invalidName'));
      return;
    }
    const api = window.electronAPI?.transferSftpFileCrossServer;
    if (!api) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api({
        sourceConnectionId,
        sourcePath: sourceFile.path,
        sourceSize: sourceFile.size,
        targetConnectionId: selectedTarget.id,
        targetConnectionName: selectedTarget.name,
        targetDirectory: targetDirectory.trim() || DEFAULT_REMOTE_PATH,
        targetName: trimmedName,
        conflictPolicy,
        preserveTimestamps: true,
      });
      if (!result.success) {
        setSubmitError(result.error || t('fileTransfer.crossServer.failed'));
        return;
      }
      onStarted(selectedTarget.name);
      onClose();
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : t('fileTransfer.crossServer.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!submitting) onClose();
      }}
      size="lg"
      closeLabel={t('common.close')}
      initialFocusRef={dirInputRef}
      title={(
        <span className="flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 shrink-0 text-accent" />
          <span>{t('fileTransfer.crossServer.title')}</span>
        </span>
      )}
    >
      <div className="space-y-4 p-4">
        {/* 源文件信息卡片 */}
        <div className="rounded-md border border-line-subtle bg-surface-sunken px-3 py-2.5">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-fg-muted">
            <span>{t('fileTransfer.crossServer.sourceFile')}</span>
            <span className="inline-flex items-center gap-1 font-mono text-fg-secondary">
              <Server className="h-3 w-3 text-accent" />
              {sourceLabel}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <FileIcon className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={sourceFile.path}>
              {sourceFile.path}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">
              {formatByteSize(sourceFile.size)}
            </span>
          </div>
        </div>

        {/* 目标服务器选择 */}
        <div className="space-y-1.5">
          <label className="industrial-field-label mb-0">
            {t('fileTransfer.crossServer.targetServer')}
          </label>
          {connectedTargets.length === 0 ? (
            <div className="rounded-md border border-line-subtle bg-surface-raised px-3.5 py-4 text-center text-xs leading-5 text-fg-muted">
              {t('fileTransfer.crossServer.noOtherConnected')}
            </div>
          ) : (
            <div className="grid max-h-32 grid-cols-1 gap-1.5 overflow-y-auto scrollbar-thin sm:grid-cols-2">
              {connectedTargets.map((target) => {
                const selected = target.id === targetConnectionId;
                return (
                  <button
                    key={target.id}
                    type="button"
                    onClick={() => setTargetConnectionId(target.id)}
                    className={`flex min-w-0 items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left transition-all ${
                      selected
                        ? 'border-accent bg-accent-muted text-fg'
                        : 'border-line-subtle bg-surface text-fg-secondary hover:border-line-strong hover:bg-surface-hover'
                    }`}
                  >
                    <span className="status-dot status-dot-connected" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-fg">{target.name}</div>
                      {target.endpoint && (
                        <div className="truncate font-mono text-[10.5px] text-fg-muted">{target.endpoint}</div>
                      )}
                    </div>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 目标目录输入 + 目录浏览器 */}
        {selectedTarget && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="industrial-field-label mb-0">
                  {t('fileTransfer.crossServer.targetDirectory')}
                </label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="icon-button h-6 w-6"
                    title={t('fileTransfer.crossServer.homeDir')}
                    onClick={() => void loadTargetFolders(selectedTarget.id, DEFAULT_REMOTE_PATH)}
                    disabled={foldersLoading}
                  >
                    <Home className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="icon-button h-6 w-6"
                    title={t('fileTransfer.crossServer.parentDir')}
                    onClick={() => void loadTargetFolders(selectedTarget.id, parentPosixPath(targetDirectory))}
                    disabled={foldersLoading || targetDirectory === '/'}
                  >
                    <CornerLeftUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="icon-button h-6 w-6"
                    title={t('common.refresh')}
                    onClick={() => void loadTargetFolders(selectedTarget.id, targetDirectory)}
                    disabled={foldersLoading}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${foldersLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              <div className="flex gap-1.5">
                <input
                  ref={dirInputRef}
                  type="text"
                  value={targetDirectory}
                  onChange={(event) => {
                    setTargetDirectory(event.target.value);
                    setSubmitError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void loadTargetFolders(selectedTarget.id, targetDirectory);
                    }
                  }}
                  placeholder={t('fileTransfer.crossServer.targetDirectoryPlaceholder')}
                  className="industrial-input min-w-0 flex-1 font-mono text-xs"
                  disabled={submitting}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="industrial-button-secondary px-2.5 py-1.5 text-xs"
                  onClick={() => void loadTargetFolders(selectedTarget.id, targetDirectory)}
                  disabled={foldersLoading || submitting}
                >
                  {t('fileTransfer.crossServer.browseFolders')}
                </button>
              </div>

              <div className="max-h-36 overflow-y-auto rounded-sm border border-line-subtle bg-surface-sunken p-1 scrollbar-thin">
                {foldersLoading ? (
                  <div className="flex items-center justify-center gap-1.5 py-5 text-xs text-fg-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                    <span>{t('fileTransfer.crossServer.loadingFolders')}</span>
                  </div>
                ) : foldersError ? (
                  <div className="px-2.5 py-3 text-center text-xs text-danger">
                    {foldersError}
                  </div>
                ) : folders.length === 0 ? (
                  <div className="py-4 text-center text-xs text-fg-subtle">
                    {t('fileTransfer.crossServer.emptyFolders')}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                    {folders.map((folder) => (
                      <button
                        key={folder.path}
                        type="button"
                        onClick={() => void loadTargetFolders(selectedTarget.id, folder.path)}
                        className="flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
                        title={folder.path}
                      >
                        <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                        <ChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 保存文件名 + 冲突处理策略 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="industrial-field-label">
                  {t('fileTransfer.crossServer.targetName')}
                </label>
                <input
                  type="text"
                  value={targetName}
                  onChange={(event) => {
                    setTargetName(event.target.value);
                    setSubmitError(null);
                  }}
                  placeholder={t('fileTransfer.crossServer.targetNamePlaceholder')}
                  className="industrial-input w-full font-mono text-xs"
                  disabled={submitting}
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="industrial-field-label">
                  {t('fileTransfer.crossServer.conflictPolicy')}
                </label>
                <div className="grid grid-cols-3 gap-1 rounded-sm border border-line-subtle bg-surface-sunken p-1">
                  {([
                    { value: 'overwrite', label: t('fileTransfer.crossServer.conflictOverwrite') },
                    { value: 'rename', label: t('fileTransfer.crossServer.conflictRename') },
                    { value: 'skip', label: t('fileTransfer.crossServer.conflictSkip') },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setConflictPolicy(option.value)}
                      className={`truncate rounded-sm px-1.5 py-1.5 text-[11px] font-medium transition-colors ${
                        conflictPolicy === option.value
                          ? 'bg-accent text-accent-fg shadow-sm'
                          : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {submitError && (
          <div className="rounded-sm border border-danger bg-danger-muted px-3 py-2 text-xs text-danger-fg">
            {submitError}
          </div>
        )}
      </div>

      <div className="industrial-modal-footer">
        <button
          type="button"
          className="industrial-button-secondary"
          onClick={onClose}
          disabled={submitting}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="industrial-button-primary"
          onClick={() => void handleSubmit()}
          disabled={submitting || !selectedTarget}
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('fileTransfer.crossServer.starting')}
            </>
          ) : (
            <>
              <ArrowRightLeft className="h-3.5 w-3.5" />
              {t('fileTransfer.crossServer.startAction')}
            </>
          )}
        </button>
      </div>
    </Modal>
  );
}
