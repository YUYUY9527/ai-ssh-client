import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ChevronRight,
  Download,
  File,
  FileText,
  Folder,
  Home,
  Image,
  ListChecks,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';

import { useI18n } from '../i18n';
import { normalizeHistoryPath } from '../history/command-history-index';
import { useSessionStore } from '../session/useSessionStore';
import {
  useSftpTransferStore,
  type SftpTransferTask,
} from '../store/useSftpTransferStore';
import { TransferTaskList } from '../transfer/TransferTaskList';
import {
  DEFAULT_REMOTE_PATH,
  type RemoteFileItem,
} from '../transfer/transfer-types';

interface FileTransferProps {
  connectionId: string;
  isLive: boolean;
  onClose?: () => void;
}

function createTaskId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Session-bound SFTP browser used inside the workspace sidebar. */
export function FileTransfer({ connectionId, isLive, onClose }: FileTransferProps) {
  const { t } = useI18n();
  const sessionCwd = useSessionStore((state) => state.sessions[connectionId]?.cwd);
  const browserState = useSftpTransferStore((state) => state.browserByConnection[connectionId]);
  const getBrowserState = useSftpTransferStore((state) => state.getBrowserState);
  const setBrowserPath = useSftpTransferStore((state) => state.setBrowserPath);
  const setBrowserView = useSftpTransferStore((state) => state.setBrowserView);
  const setBrowserSelection = useSftpTransferStore((state) => state.setBrowserSelection);
  const transferTasks = useSftpTransferStore((state) => state.tasks);
  const addTransferTask = useSftpTransferStore((state) => state.addTask);
  const markTransferTaskTransferring = useSftpTransferStore((state) => state.markTransferring);
  const completeTransferTask = useSftpTransferStore((state) => state.completeTask);
  const removeTransferTask = useSftpTransferStore((state) => state.removeTask);
  const clearCompletedTasks = useSftpTransferStore((state) => state.clearCompletedTasks);

  const resolvedBrowser = browserState ?? {
    remotePath: sessionCwd || DEFAULT_REMOTE_PATH,
    activeView: 'files' as const,
    selectedPath: null,
  };
  const currentPath = resolvedBrowser.remotePath || DEFAULT_REMOTE_PATH;
  const activeView = resolvedBrowser.activeView;
  const selectedPath = resolvedBrowser.selectedPath;

  const [pathInput, setPathInput] = useState(currentPath);
  const [files, setFiles] = useState<RemoteFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const refreshedUploadTasksRef = useRef<Set<string>>(new Set());
  const loadRequestRef = useRef(0);

  const visibleTransferTasks = useMemo(
    () => transferTasks
      .filter((task) => task.connectionId === connectionId)
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [connectionId, transferTasks],
  );
  const activeTaskCount = visibleTransferTasks.filter(
    (task) => task.status === 'pending' || task.status === 'transferring',
  ).length;
  const hasTransferTasks = visibleTransferTasks.length > 0;
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;

  const loadDirectory = useCallback(async (path: string) => {
    if (!isLive) {
      setError(t('fileTransfer.connectionOffline'));
      setLoading(false);
      return;
    }

    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError(null);

    try {
      if (!window.electronAPI) {
        throw new Error(t('fileTransfer.loadFailed'));
      }

      const result = await window.electronAPI.listDirectory(connectionId, path);
      if (requestId !== loadRequestRef.current) {
        return;
      }

      if (result.success) {
        setFiles(result.data.files);
        setBrowserPath(connectionId, path);
        setPathInput(path);
      } else {
        setError(result.error || t('fileTransfer.loadFailed'));
      }
    } catch (err) {
      if (requestId !== loadRequestRef.current) {
        return;
      }
      setError((err as Error).message);
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
      }
    }
  }, [connectionId, isLive, setBrowserPath, t]);

  // 会话切换时恢复该会话上次路径；首次进入优先用终端 cwd
  useEffect(() => {
    const existing = useSftpTransferStore.getState().browserByConnection[connectionId];
    const preferredPath = existing?.remotePath
      || useSessionStore.getState().sessions[connectionId]?.cwd
      || DEFAULT_REMOTE_PATH;

    if (!existing) {
      getBrowserState(connectionId, preferredPath);
    }

    // 切换会话时先清空旧列表，避免短暂显示上一会话内容
    setFiles([]);
    setError(null);
    setPathInput(preferredPath);
    void loadDirectory(preferredPath);
  }, [connectionId, getBrowserState, isLive, loadDirectory]);

  useEffect(() => {
    const completedUpload = visibleTransferTasks.find((task) => (
      task.type === 'upload'
      && task.status === 'completed'
      && !refreshedUploadTasksRef.current.has(task.id)
    ));

    if (!completedUpload || !isLive) {
      return;
    }

    refreshedUploadTasksRef.current.add(completedUpload.id);
    void loadDirectory(currentPath);
  }, [currentPath, isLive, loadDirectory, visibleTransferTasks]);

  const getFileIcon = (file: RemoteFileItem) => {
    if (file.isDirectory) return <Folder className="w-5 h-5 text-teal-400" />;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext || '')) {
      return <Image className="w-5 h-5 text-purple-400" />;
    }
    if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext || '')) {
      return <Archive className="w-5 h-5 text-yellow-400" />;
    }
    if (['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'conf', 'log'].includes(ext || '')) {
      return <FileText className="w-5 h-5 text-gray-400" />;
    }
    return <File className="w-5 h-5 text-green-400" />;
  };

  const getFileType = (file: RemoteFileItem): string => {
    if (file.isDirectory) return t('fileTransfer.fileTypes.directory');
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (['', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) return t('fileTransfer.fileTypes.image');
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) return t('fileTransfer.fileTypes.archive');
    if (['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'conf', 'log', 'ini', 'cfg'].includes(ext)) return t('fileTransfer.fileTypes.text');
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh'].includes(ext)) return t('fileTransfer.fileTypes.code');
    if (['html', 'css', 'scss', 'sass', 'less'].includes(ext)) return 'Web';
    if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(ext)) return t('fileTransfer.fileTypes.audio');
    if (['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'].includes(ext)) return t('fileTransfer.fileTypes.video');
    if (['pdf'].includes(ext)) return 'PDF';
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'Office';
    if (ext) return `${ext.toUpperCase()} ${t('fileTransfer.fileTypes.file')}`;
    return t('fileTransfer.fileTypes.file');
  };

  const navigateTo = (path: string) => {
    void loadDirectory(path);
  };

  const goUp = () => {
    if (currentPath === '/') {
      return;
    }
    navigateTo(normalizeHistoryPath(`${currentPath.replace(/\/$/, '')}/..`));
  };

  const goHome = () => {
    navigateTo(sessionCwd || DEFAULT_REMOTE_PATH);
  };

  const handleDownload = async (file: RemoteFileItem) => {
    if (!isLive) {
      return;
    }

    const task: SftpTransferTask = {
      id: createTaskId(),
      connectionId,
      name: file.name,
      type: 'download',
      progress: 0,
      status: 'pending',
      remotePath: file.path,
      updatedAt: Date.now(),
    };

    addTransferTask(task);
    setBrowserView(connectionId, 'tasks');

    try {
      markTransferTaskTransferring(task.id);
      if (!window.electronAPI) {
        throw new Error(t('fileTransfer.loadFailed'));
      }

      const result = await window.electronAPI.downloadFile(connectionId, file.path, task.id);
      if (result.success) {
        return;
      }

      if (result.error !== 'Cancelled') {
        completeTransferTask({
          connectionId,
          taskId: task.id,
          filename: file.name,
          transferType: 'download',
          success: false,
          error: result.error,
          remotePath: file.path,
        });
        return;
      }

      removeTransferTask(task.id);
    } catch (err) {
      completeTransferTask({
        connectionId,
        taskId: task.id,
        filename: file.name,
        transferType: 'download',
        success: false,
        error: (err as Error).message,
        remotePath: file.path,
      });
    }
  };

  const handleUpload = async (localPath?: string) => {
    if (!isLive) {
      return;
    }

    let selectedLocalPath = localPath;
    if (!selectedLocalPath && window.electronAPI) {
      const result = await window.electronAPI.selectFile({
        title: t('common.upload'),
        properties: ['openFile'],
      });
      if (!result.success || result.data?.canceled || !result.data?.filePath) {
        return;
      }
      selectedLocalPath = result.data.filePath;
    }

    if (!selectedLocalPath) {
      return;
    }

    const filename = selectedLocalPath.split(/[/\\]/).pop() || 'unknown';
    const remotePath = `${currentPath.replace(/\/$/, '')}/${filename}`;
    const task: SftpTransferTask = {
      id: createTaskId(),
      connectionId,
      name: filename,
      type: 'upload',
      progress: 0,
      status: 'pending',
      localPath: selectedLocalPath,
      remotePath,
      updatedAt: Date.now(),
    };

    addTransferTask(task);
    setBrowserView(connectionId, 'tasks');

    try {
      markTransferTaskTransferring(task.id);
      if (!window.electronAPI) {
        throw new Error(t('fileTransfer.loadFailed'));
      }

      const result = await window.electronAPI.uploadFile(
        connectionId,
        selectedLocalPath,
        currentPath,
        task.id,
      );
      if (result.success) {
        return;
      }

      if (result.error !== 'Cancelled') {
        completeTransferTask({
          connectionId,
          taskId: task.id,
          filename,
          transferType: 'upload',
          success: false,
          error: result.error,
          localPath: selectedLocalPath,
          remotePath,
        });
        return;
      }

      removeTransferTask(task.id);
    } catch (err) {
      completeTransferTask({
        connectionId,
        taskId: task.id,
        filename,
        transferType: 'upload',
        success: false,
        error: (err as Error).message,
        localPath: selectedLocalPath,
        remotePath,
      });
    }
  };

  useEffect(() => {
    const dropZone = dropZoneRef.current;
    if (!dropZone || !isLive) return;

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dropZone.contains(e.relatedTarget as Node)) {
        setIsDragOver(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      await handleUpload();
    };

    dropZone.addEventListener('dragenter', handleDragEnter);
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);

    return () => {
      dropZone.removeEventListener('dragenter', handleDragEnter);
      dropZone.removeEventListener('dragover', handleDragOver);
      dropZone.removeEventListener('dragleave', handleDragLeave);
      dropZone.removeEventListener('drop', handleDrop);
    };
  }, [connectionId, currentPath, isLive]);

  const isHomePath = currentPath === '~' || currentPath.startsWith('~/');
  const pathParts = (isHomePath ? currentPath.replace(/^~\/?/, '') : currentPath)
    .split('/')
    .filter(Boolean);
  const pathRoot = isHomePath ? '~' : '/';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color-mix(in_srgb,var(--bg-primary)_76%,var(--bg-secondary))]">
      <div className="flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
            <Folder className="h-4 w-4 shrink-0 text-teal-500" />
            <span className="truncate">{t('fileTransfer.title')}</span>
          </h2>
          <p className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
            {isLive ? t('fileTransfer.sessionBound') : t('fileTransfer.connectionOffline')}
          </p>
        </div>
        {onClose && (
          <button onClick={onClose} className="icon-button h-7 w-7" title={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_48%,var(--bg-secondary))] p-2.5">
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setBrowserView(connectionId, 'files')}
            className={
              activeView === 'files'
                ? 'industrial-button-primary px-2.5 py-1.5'
                : 'industrial-button-secondary px-2.5 py-1.5'
            }
            title={t('fileTransfer.files')}
          >
            <Folder className="h-4 w-4" />
            {t('fileTransfer.files')}
          </button>
          <button
            onClick={() => setBrowserView(connectionId, 'tasks')}
            className={
              activeView === 'tasks'
                ? 'industrial-button-primary px-2.5 py-1.5'
                : 'industrial-button-secondary px-2.5 py-1.5'
            }
            title={t('fileTransfer.transferTasks')}
          >
            <ListChecks className="h-4 w-4" />
            {t('fileTransfer.tasks')}
            {hasTransferTasks && (
              <span className="ml-1 rounded-sm bg-white/20 px-1.5 text-[11px] tabular-nums">
                {activeTaskCount > 0 ? activeTaskCount : visibleTransferTasks.length}
              </span>
            )}
          </button>
        </div>

        {activeView === 'files' && (
          <>
            <button
              onClick={goHome}
              className="icon-button h-8 w-8"
              title={t('fileTransfer.homeDir')}
              disabled={!isLive}
            >
              <Home className="h-4 w-4" />
            </button>
            <button
              onClick={goUp}
              className="icon-button h-8 w-8"
              title={t('fileTransfer.parentDir')}
              disabled={!isLive}
            >
              <ChevronRight className="h-4 w-4 rotate-180" />
            </button>
            <button
              onClick={() => void loadDirectory(currentPath)}
              className="icon-button h-8 w-8"
              title={t('common.refresh')}
              disabled={!isLive}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void loadDirectory(pathInput);
                }
              }}
              className="industrial-input min-w-0 flex-1 py-1"
              placeholder={t('fileTransfer.pathPlaceholder')}
              disabled={!isLive}
            />
          </>
        )}

        {activeView === 'tasks' && (
          <div className="flex-1" />
        )}

        {activeView === 'tasks' ? (
          <button
            onClick={() => clearCompletedTasks(connectionId)}
            className="industrial-button-secondary px-2.5 py-1.5"
            disabled={!visibleTransferTasks.some((task) => task.status === 'completed' || task.status === 'error')}
          >
            {t('fileTransfer.clearFinished')}
          </button>
        ) : (
          <button
            onClick={() => void handleUpload()}
            className="industrial-button-primary px-2.5 py-1.5"
            disabled={!isLive}
          >
            <Upload className="h-4 w-4" />
            {t('common.upload')}
          </button>
        )}
      </div>

      {activeView === 'files' && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_66%,var(--bg-secondary))] px-3 py-2 text-sm">
          <button
            onClick={() => navigateTo(pathRoot)}
            className="whitespace-nowrap text-slate-500 hover:text-teal-500 disabled:opacity-50"
            disabled={!isLive}
          >
            {pathRoot}
          </button>
          {pathParts.map((part, index) => (
            <span key={`${part}-${index}`} className="flex items-center">
              <ChevronRight className="mx-0.5 h-3 w-3 text-slate-400" />
              <button
                onClick={() => navigateTo(
                  `${isHomePath ? '~/' : '/'}${pathParts.slice(0, index + 1).join('/')}`,
                )}
                className="whitespace-nowrap text-slate-500 hover:text-teal-500 disabled:opacity-50"
                disabled={!isLive}
              >
                {part}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeView === 'tasks' ? (
          <TransferTaskList
            tasks={visibleTransferTasks}
            onRemoveTask={removeTransferTask}
            translate={t}
          />
        ) : (
          <div
            ref={dropZoneRef}
            className={`file-transfer-scroll relative h-full overflow-y-auto p-2 ${isDragOver ? 'bg-teal-50 ring-2 ring-inset ring-teal-500 dark:bg-teal-900/20' : ''}`}
          >
            {!isLive ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-500 dark:text-slate-400">
                <AlertCircle className="h-6 w-6 text-amber-500" />
                <p>{t('fileTransfer.connectionOffline')}</p>
                {hasTransferTasks && (
                  <button
                    onClick={() => setBrowserView(connectionId, 'tasks')}
                    className="industrial-button-secondary px-3 py-1.5"
                  >
                    {t('fileTransfer.viewTasks')}
                  </button>
                )}
              </div>
            ) : loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="flex items-center text-red-500">
                  <AlertCircle className="mr-2 h-5 w-5" />
                  {error}
                </div>
                <button
                  onClick={() => void loadDirectory(currentPath)}
                  className="industrial-button-secondary px-3 py-1.5"
                >
                  <RefreshCw className="h-4 w-4" />
                  {t('common.retry')}
                </button>
              </div>
            ) : files.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-slate-400">
                <Folder className="mb-2 h-12 w-12 opacity-50" />
                <p className="text-sm">{t('fileTransfer.emptyDir')}</p>
                <p className="mt-1 text-xs">{t('fileTransfer.dragHint')}</p>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="industrial-table-head grid grid-cols-[minmax(0,4.4fr)_minmax(0,2fr)_minmax(5.5rem,1.2fr)_minmax(11.5rem,1.8fr)_2rem] gap-3">
                  <div>{t('fileTransfer.tableHeaders.name')}</div>
                  <div>{t('fileTransfer.tableHeaders.type')}</div>
                  <div className="text-right">{t('fileTransfer.tableHeaders.size')}</div>
                  <div className="text-right">{t('fileTransfer.tableHeaders.modified')}</div>
                  <div />
                </div>
                {files.map((file) => {
                  const isSelected = selectedFile?.path === file.path;
                  return (
                    <div
                      key={file.path}
                      onClick={() => {
                        if (file.isDirectory) {
                          navigateTo(file.path);
                          return;
                        }
                        setBrowserSelection(connectionId, file.path);
                      }}
                      onDoubleClick={() => file.isDirectory && navigateTo(file.path)}
                      className={`grid cursor-pointer grid-cols-[minmax(0,4.4fr)_minmax(0,2fr)_minmax(5.5rem,1.2fr)_minmax(11.5rem,1.8fr)_2rem] gap-3 rounded-sm px-3 py-2 transition-colors group ${
                        isSelected
                          ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
                          : 'hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {getFileIcon(file)}
                        <span className="truncate text-sm text-slate-900 dark:text-white" title={file.name}>
                          {file.name}
                        </span>
                      </div>
                      <div className="flex min-w-0 items-center text-sm text-slate-500 dark:text-slate-400">
                        {getFileType(file)}
                      </div>
                      <div className="whitespace-nowrap text-right text-sm tabular-nums text-slate-500 dark:text-slate-400">
                        {file.isDirectory ? '-' : formatSize(file.size)}
                      </div>
                      <div className="whitespace-nowrap text-right text-sm tabular-nums text-slate-500 dark:text-slate-400">
                        {formatTime(file.mtime)}
                      </div>
                      <div className="flex items-center justify-end opacity-0 transition-opacity group-hover:opacity-100">
                        {!file.isDirectory && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDownload(file);
                            }}
                            className="icon-button h-7 w-7 text-teal-500"
                            title={t('common.download')}
                          >
                            <Download className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {isDragOver && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm border-2 border-dashed border-teal-500 bg-teal-500/20">
                <div className="font-medium text-teal-500">{t('fileTransfer.dropHint')}</div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_56%,var(--bg-secondary))] p-2.5 text-xs text-slate-500 dark:text-slate-400">
        {activeView === 'tasks' ? (
          <span>{t('fileTransfer.taskCount', { count: visibleTransferTasks.length })}</span>
        ) : (
          <span>{t('fileTransfer.itemCount', { count: files.length })}</span>
        )}
        <span className="tabular-nums">
          {activeTaskCount > 0
            ? t('fileTransfer.activeTaskCount', { count: activeTaskCount })
            : 'SFTP'}
        </span>
      </div>
    </div>
  );
}
