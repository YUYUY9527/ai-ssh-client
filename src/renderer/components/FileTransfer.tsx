import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ChevronRight,
  Download,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Image,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { ConfirmDialog } from './ConfirmDialog';
import { useI18n } from '../i18n';
import { normalizeHistoryPath } from '../history/command-history-index';
import { useSessionStore } from '../session/useSessionStore';
import { Modal } from '../shared-ui/Modal';
import {
  useSftpTransferStore,
} from '../store/useSftpTransferStore';
import { SftpConflictDialog } from '../transfer/SftpConflictDialog';
import { TransferTaskList } from '../transfer/TransferTaskList';
import { useSftpTransferController } from '../transfer/useSftpTransferController';
import {
  DEFAULT_REMOTE_PATH,
  type RemoteFileItem,
} from '../transfer/transfer-types';

interface FileTransferProps {
  connectionId: string;
  isLive: boolean;
  onClose?: () => void;
}

/** 拼接单层子路径。 */
function joinRemoteChild(parent: string, name: string): string {
  if (!parent || parent === '/') return `/${name}`;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

/** 规范化地址栏路径：去空白、折叠重复斜杠，空输入回落家目录。/home 是真实目录，不改写成 ~。 */
function normalizeRemoteBrowsePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\/g, '/');
  if (!trimmed) {
    return DEFAULT_REMOTE_PATH;
  }
  // 家目录记法：~、~/、~/a//b
  if (trimmed === '~' || trimmed === '~/') {
    return DEFAULT_REMOTE_PATH;
  }
  if (trimmed.startsWith('~/')) {
    return normalizeHistoryPath(trimmed);
  }
  // 绝对路径（含 /home、/root 等）原样规范化
  if (trimmed.startsWith('/')) {
    return normalizeHistoryPath(trimmed);
  }
  // 相对路径按家目录子路径处理，避免 SFTP 相对当前目录语义含糊
  return normalizeHistoryPath(`~/${trimmed}`);
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
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
  const setBrowserPath = useSftpTransferStore((state) => state.setBrowserPath);
  const requestBrowserPath = useSftpTransferStore((state) => state.requestBrowserPath);
  const setBrowserView = useSftpTransferStore((state) => state.setBrowserView);
  const setBrowserSelection = useSftpTransferStore((state) => state.setBrowserSelection);
  const setBrowserSelectedPaths = useSftpTransferStore((state) => state.setBrowserSelectedPaths);
  const toggleBrowserSelection = useSftpTransferStore((state) => state.toggleBrowserSelection);
  const extendBrowserSelection = useSftpTransferStore((state) => state.extendBrowserSelection);
  const clearBrowserSelection = useSftpTransferStore((state) => state.clearBrowserSelection);
  const transferTasks = useSftpTransferStore((state) => state.tasks);
  const removeTransferTask = useSftpTransferStore((state) => state.removeTask);
  const clearCompletedTasks = useSftpTransferStore((state) => state.clearCompletedTasks);

  const resolvedBrowser = browserState ?? {
    remotePath: sessionCwd || DEFAULT_REMOTE_PATH,
    activeView: 'files' as const,
    selectedPaths: [],
    selectionAnchorPath: null,
    navigationVersion: 0,
  };
  const currentPath = resolvedBrowser.remotePath || DEFAULT_REMOTE_PATH;
  const transferController = useSftpTransferController(
    connectionId,
    currentPath,
    () => setBrowserView(connectionId, 'tasks'),
  );
  const activeView = resolvedBrowser.activeView;
  const selectedPaths = resolvedBrowser.selectedPaths;
  const navigationVersion = resolvedBrowser.navigationVersion ?? 0;

  const [pathInput, setPathInput] = useState(currentPath);
  const [files, setFiles] = useState<RemoteFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: RemoteFileItem;
  } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [renameTarget, setRenameTarget] = useState<RemoteFileItem | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<RemoteFileItem[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const [isCreatingDir, setIsCreatingDir] = useState(false);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const mkdirInputRef = useRef<HTMLInputElement>(null);
  const refreshedUploadTasksRef = useRef<Set<string>>(new Set());
  const loadRequestRef = useRef(0);
  const handledNavigationVersionRef = useRef(navigationVersion);

  const visibleTransferTasks = useMemo(
    () => transferTasks
      .filter((task) => task.connectionId === connectionId)
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [connectionId, transferTasks],
  );
  const activeTaskCount = visibleTransferTasks.filter(
    (task) => !['completed', 'skipped', 'canceled', 'interrupted', 'failed', 'handed-off'].includes(task.status),
  ).length;
  const hasTransferTasks = visibleTransferTasks.length > 0;
  const selectedFiles = useMemo(
    () => files.filter((file) => selectedPaths.includes(file.path)),
    [files, selectedPaths],
  );
  const orderedPaths = useMemo(() => files.map((file) => file.path), [files]);
  const allSelected = files.length > 0 && files.every((file) => selectedPaths.includes(file.path));
  const selectedHasDirectory = selectedFiles.some((file) => file.isDirectory);
  const conflictTask = useMemo(
    () => visibleTransferTasks.find((task) => task.status === 'waiting-conflict') ?? null,
    [visibleTransferTasks],
  );

  const loadDirectory = useCallback(async (path: string): Promise<boolean> => {
    const targetPath = normalizeRemoteBrowsePath(path);
    if (!isLive) {
      setError(t('fileTransfer.connectionOffline'));
      setLoading(false);
      return false;
    }

    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    // 先写入目标路径，避免失败后刷新/重试仍落回旧的 ~
    setPathInput(targetPath);
    setBrowserPath(connectionId, targetPath);

    try {
      if (!window.electronAPI) {
        throw new Error(t('fileTransfer.loadFailed'));
      }

      const result = await window.electronAPI.listDirectory(connectionId, targetPath);
      if (requestId !== loadRequestRef.current) {
        return false;
      }

      if (result.success) {
        const nextFiles = result.data.files;
        // 服务端 realpath 后的规范路径（绝对路径），用于地址栏与后续导航
        const resolvedPath = normalizeRemoteBrowsePath(result.data.path || targetPath);
        setFiles(nextFiles);
        setPathInput(resolvedPath);
        setBrowserPath(connectionId, resolvedPath);
        // 刷新时剔除已不存在的选中路径。
        const existing = new Set(nextFiles.map((file) => file.path));
        const currentSelected = useSftpTransferStore.getState()
          .browserByConnection[connectionId]?.selectedPaths || [];
        const retained = currentSelected.filter((item) => existing.has(item));
        if (retained.length !== currentSelected.length) {
          setBrowserSelectedPaths(connectionId, retained);
        }
        return true;
      }
      setError(result.error || t('fileTransfer.loadFailed'));
      return false;
    } catch (err) {
      if (requestId !== loadRequestRef.current) {
        return false;
      }
      setError((err as Error).message);
      return false;
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
      }
    }
  }, [connectionId, isLive, setBrowserPath, setBrowserSelectedPaths, t]);

  // 用 ref 持有最新 loadDirectory，避免 effect 因回调换引用反复重置路径
  const loadDirectoryRef = useRef(loadDirectory);
  loadDirectoryRef.current = loadDirectory;
  // 记录已完成初始化的 connectionId，避免 isLive 抖动把路径打回 ~
  const bootstrappedConnectionRef = useRef<string | null>(null);
  const wasLiveRef = useRef(isLive);

  // 仅在切换会话时初始化；依赖只用 connectionId，防止回调引用变化重置目录
  useEffect(() => {
    const store = useSftpTransferStore.getState();
    const existing = store.browserByConnection[connectionId];
    // /home 是真实目录，不再迁移成 ~；仅空路径回落默认
    const preferredPath = normalizeRemoteBrowsePath(
      existing?.remotePath
      || useSessionStore.getState().sessions[connectionId]?.cwd
      || DEFAULT_REMOTE_PATH,
    );

    if (!existing) {
      store.getBrowserState(connectionId, preferredPath);
    }

    setFiles([]);
    setError(null);
    setActionError(null);
    setPathInput(preferredPath);
    handledNavigationVersionRef.current = existing?.navigationVersion ?? 0;
    bootstrappedConnectionRef.current = connectionId;
    wasLiveRef.current = isLive;
    if (isLive) {
      void loadDirectoryRef.current(preferredPath);
    }
  }, [connectionId]);

  // 从离线恢复在线时，按 store 当前路径刷新，绝不回落到会话默认 ~
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = isLive;
    if (!isLive || wasLive) {
      return;
    }
    if (bootstrappedConnectionRef.current !== connectionId) {
      return;
    }
    const path = useSftpTransferStore.getState()
      .browserByConnection[connectionId]?.remotePath || DEFAULT_REMOTE_PATH;
    void loadDirectoryRef.current(path);
  }, [connectionId, isLive]);

  // 响应 requestBrowserPath：统一导航入口（地址栏/双击/终端右键）
  useEffect(() => {
    if (!isLive) {
      return;
    }
    if (handledNavigationVersionRef.current === navigationVersion) {
      return;
    }
    handledNavigationVersionRef.current = navigationVersion;
    setPathInput(currentPath);
    setBrowserView(connectionId, 'files');
    void loadDirectoryRef.current(currentPath);
  }, [connectionId, currentPath, isLive, navigationVersion, setBrowserView]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const close = () => setContextMenu(null);
    const handleClick = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenuRef.current || !contextMenu) {
      return;
    }

    const menuRect = contextMenuRef.current.getBoundingClientRect();
    setContextMenuPosition({
      x: Math.max(8, Math.min(contextMenu.x, window.innerWidth - menuRect.width - 8)),
      y: Math.max(8, Math.min(contextMenu.y, window.innerHeight - menuRect.height - 8)),
    });
  }, [contextMenu]);

  useEffect(() => {
    if (!renameTarget) {
      return;
    }
    const frame = requestAnimationFrame(() => renameInputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [renameTarget]);

  useEffect(() => {
    if (!mkdirOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => mkdirInputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [mkdirOpen]);

  useEffect(() => {
    const completedUpload = visibleTransferTasks.find((task) => (
      task.direction === 'upload'
      && task.status === 'completed'
      && !refreshedUploadTasksRef.current.has(task.taskId)
    ));

    if (!completedUpload || !isLive) {
      return;
    }

    refreshedUploadTasksRef.current.add(completedUpload.taskId);
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
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) return t('fileTransfer.fileTypes.image');
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

  /** 所有目录跳转走 requestBrowserPath，保证侧栏已打开时也会强制刷新 */
  const navigateTo = useCallback((path: string) => {
    const nextPath = normalizeRemoteBrowsePath(path);
    requestBrowserPath(connectionId, nextPath);
  }, [connectionId, requestBrowserPath]);

  /** 提交地址栏路径（回车确认）。 */
  const commitPathInput = useCallback(() => {
    const nextPath = normalizeRemoteBrowsePath(pathInput);
    if (nextPath === normalizeRemoteBrowsePath(currentPath) && files.length > 0 && !error) {
      setPathInput(nextPath);
      return;
    }
    navigateTo(nextPath);
  }, [currentPath, error, files.length, navigateTo, pathInput]);

  const goUp = () => {
    const base = normalizeRemoteBrowsePath(currentPath);
    if (base === '/') {
      return;
    }
    // 家目录根：先按 ~ 的父级请求，服务端 realpath 会落到绝对路径
    if (base === '~') {
      navigateTo('~/..');
      return;
    }
    navigateTo(normalizeHistoryPath(`${base.replace(/\/$/, '')}/..`));
  };

  const goHome = () => {
    navigateTo(DEFAULT_REMOTE_PATH);
  };

  const handleItemClick = (event: React.MouseEvent, file: RemoteFileItem) => {
    if (event.shiftKey) {
      extendBrowserSelection(connectionId, orderedPaths, file.path);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      toggleBrowserSelection(connectionId, file.path);
      return;
    }
    setBrowserSelection(connectionId, file.path);
  };

  const handleSelectAll = () => {
    if (allSelected) {
      clearBrowserSelection(connectionId);
      return;
    }
    setBrowserSelectedPaths(connectionId, orderedPaths, orderedPaths[0] ?? null);
  };

  const handleDownload = async (file: RemoteFileItem) => {
    if (!isLive || file.isDirectory) return;
    const errorMessage = await transferController.download([file.path]);
    if (errorMessage) setActionError(errorMessage);
  };

  const handleBatchDownload = async () => {
    if (!isLive || selectedFiles.length === 0) return;
    if (selectedHasDirectory) {
      setActionError(t('fileTransfer.batchDownloadDirectoriesUnsupported'));
      return;
    }
    const errorMessage = await transferController.download(selectedFiles.map((file) => file.path));
    if (errorMessage) setActionError(errorMessage);
  };

  const openRenameDialog = (item: RemoteFileItem) => {
    setContextMenu(null);
    setRenameTarget(item);
    setRenameName(item.name);
    setRenameError(null);
  };

  const handleRename = async () => {
    if (!renameTarget || isRenaming) {
      return;
    }
    if (renameName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    if (
      !renameName.trim()
      || renameName === '.'
      || renameName === '..'
      || renameName.includes('/')
      || renameName.includes('\0')
    ) {
      setRenameError(t('fileTransfer.invalidName'));
      return;
    }
    if (!window.electronAPI) {
      setRenameError(t('fileTransfer.renameFailed'));
      return;
    }

    setIsRenaming(true);
    setRenameError(null);
    try {
      const result = await window.electronAPI.renameItem(
        connectionId,
        renameTarget.path,
        renameName,
      );
      if (!result.success) {
        setRenameError(result.error || t('fileTransfer.renameFailed'));
        return;
      }

      setRenameTarget(null);
      await loadDirectory(currentPath);
    } catch (err) {
      setRenameError((err as Error).message || t('fileTransfer.renameFailed'));
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (deleteTargets.length === 0 || isDeleting) {
      return;
    }
    setIsDeleting(true);
    setActionError(null);
    if (!window.electronAPI) {
      setActionError(t('fileTransfer.deleteFailed'));
      setIsDeleting(false);
      return;
    }

    try {
      const paths = deleteTargets.map((item) => item.path);
      const result = await window.electronAPI.deleteSftpItems(connectionId, paths);
      if (!result.success) {
        setDeleteTargets([]);
        setActionError(result.error || t('fileTransfer.deleteFailed'));
        return;
      }

      const failed = result.data.items.filter((item) => !item.success);
      if (failed.length > 0) {
        setBrowserSelectedPaths(connectionId, failed.map((item) => item.path));
        setActionError(t('fileTransfer.batchDeletePartial', {
          deleted: result.data.deletedCount,
          failed: result.data.failedCount,
        }));
      } else {
        clearBrowserSelection(connectionId);
      }
      setDeleteTargets([]);
      await loadDirectory(currentPath);
    } catch (err) {
      setDeleteTargets([]);
      setActionError((err as Error).message || t('fileTransfer.deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMkdir = async () => {
    if (isCreatingDir) return;
    const name = mkdirName.trim();
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      setMkdirError(t('fileTransfer.invalidName'));
      return;
    }
    if (!window.electronAPI) {
      setMkdirError(t('fileTransfer.mkdirFailed'));
      return;
    }
    setIsCreatingDir(true);
    setMkdirError(null);
    try {
      const remotePath = joinRemoteChild(currentPath, name);
      const result = await window.electronAPI.createSftpDirectory(connectionId, remotePath);
      if (!result.success) {
        setMkdirError(result.error || t('fileTransfer.mkdirFailed'));
        return;
      }
      setMkdirOpen(false);
      setMkdirName('');
      await loadDirectory(currentPath);
    } catch (err) {
      setMkdirError((err as Error).message || t('fileTransfer.mkdirFailed'));
    } finally {
      setIsCreatingDir(false);
    }
  };

  const handleUpload = async () => {
    if (!isLive) return;
    const errorMessage = await transferController.upload();
    if (errorMessage) setActionError(errorMessage);
  };

  const handleTaskAction = async (
    action: 'cancel' | 'retry' | 'discard' | 'remove',
    taskId: string,
  ) => {
    if (action === 'remove') {
      removeTransferTask(taskId);
      return;
    }
    const runner = action === 'cancel'
      ? transferController.cancel
      : action === 'retry'
        ? transferController.retry
        : transferController.discard;
    const errorMessage = await runner(taskId);
    if (errorMessage) setActionError(errorMessage);
    if (action === 'discard') {
      removeTransferTask(taskId);
    }
  };

  useEffect(() => {
    const dropZone = dropZoneRef.current;
    if (!dropZone || !isLive) return;

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer?.types?.includes('Files')) {
        setIsDragOver(true);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer?.types?.includes('Files')) {
        e.dataTransfer.dropEffect = 'copy';
        setIsDragOver(true);
      }
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
      // 仅响应文件拖放，避免与工作区 tab 的 text/plain 冲突。
      if (!e.dataTransfer?.types?.includes('Files')) {
        return;
      }
      const dropped = Array.from(e.dataTransfer.files || []);
      if (dropped.length === 0) {
        const errorMessage = await transferController.upload();
        if (errorMessage) setActionError(errorMessage);
        return;
      }
      const errorMessage = await transferController.uploadDroppedFiles(dropped);
      if (errorMessage) setActionError(errorMessage);
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
  }, [connectionId, currentPath, isLive, transferController]);

  const isHomePath = currentPath === '~' || currentPath.startsWith('~/');
  const pathParts = (isHomePath ? currentPath.replace(/^~\/?/, '') : currentPath)
    .split('/')
    .filter(Boolean);
  const pathRoot = isHomePath ? '~' : '/';
  const deleteMessage = deleteTargets.length === 1
    ? (deleteTargets[0].isDirectory
      ? t('fileTransfer.deleteDirectoryMessage', { name: deleteTargets[0].name })
      : t('fileTransfer.deleteFileMessage', { name: deleteTargets[0].name }))
    : t('fileTransfer.batchDeleteMessage', {
      files: deleteTargets.filter((item) => !item.isDirectory).length,
      directories: deleteTargets.filter((item) => item.isDirectory).length,
    });

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
              onClick={() => void loadDirectory(pathInput || currentPath)}
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
                  e.preventDefault();
                  commitPathInput();
                }
              }}
              className="industrial-input min-w-0 flex-1 py-1"
              placeholder={t('fileTransfer.pathPlaceholder')}
              disabled={!isLive}
              spellCheck={false}
              autoComplete="off"
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
            disabled={!visibleTransferTasks.some((task) => ['completed', 'skipped', 'canceled', 'interrupted', 'failed', 'handed-off'].includes(task.status))}
          >
            {t('fileTransfer.clearFinished')}
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => {
                setMkdirOpen(true);
                setMkdirName('');
                setMkdirError(null);
              }}
              className="industrial-button-secondary px-2.5 py-1.5"
              disabled={!isLive}
              title={t('fileTransfer.mkdir')}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
            <button
              onClick={() => void handleBatchDownload()}
              className="industrial-button-secondary px-2.5 py-1.5"
              disabled={!isLive || selectedFiles.length === 0 || selectedHasDirectory}
              title={selectedHasDirectory
                ? t('fileTransfer.batchDownloadDirectoriesUnsupported')
                : t('common.download')}
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                if (selectedFiles.length === 0) return;
                setDeleteTargets(selectedFiles);
              }}
              className="industrial-button-secondary px-2.5 py-1.5"
              disabled={!isLive || selectedFiles.length === 0}
              title={t('common.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => void handleUpload()}
              className="industrial-button-primary px-2.5 py-1.5"
              disabled={!isLive}
            >
              <Upload className="h-4 w-4" />
              {t('common.upload')}
            </button>
          </div>
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
            onCancelTask={(taskId) => void handleTaskAction('cancel', taskId)}
            onRetryTask={(taskId) => void handleTaskAction('retry', taskId)}
            onDiscardTask={(taskId) => void handleTaskAction('discard', taskId)}
            onRemoveTask={(taskId) => void handleTaskAction('remove', taskId)}
            translate={t}
          />
        ) : (
          <div
            ref={dropZoneRef}
            className={`file-transfer-scroll relative h-full overflow-y-auto p-2 ${isDragOver ? 'bg-teal-50 ring-2 ring-inset ring-teal-500 dark:bg-teal-900/20' : ''}`}
          >
            {actionError && (
              <div className="mb-2 flex items-center gap-2 rounded-sm border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{actionError}</span>
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="icon-button h-6 w-6"
                  title={t('common.close')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
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
                  onClick={() => void loadDirectory(pathInput || currentPath)}
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
                <div className="industrial-table-head grid grid-cols-[1.5rem_minmax(0,4.4fr)_minmax(0,2fr)_minmax(5.5rem,1.2fr)_minmax(11.5rem,1.8fr)] gap-3">
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={handleSelectAll}
                      title={t('fileTransfer.selectAll')}
                    />
                  </div>
                  <div>{t('fileTransfer.tableHeaders.name')}</div>
                  <div>{t('fileTransfer.tableHeaders.type')}</div>
                  <div className="text-right">{t('fileTransfer.tableHeaders.size')}</div>
                  <div className="text-right">{t('fileTransfer.tableHeaders.modified')}</div>
                </div>
                {files.map((file) => {
                  const isSelected = selectedPaths.includes(file.path);
                  return (
                    <div
                      key={file.path}
                      onClick={(event) => handleItemClick(event, file)}
                      onDoubleClick={() => file.isDirectory && navigateTo(file.path)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        // 右键未选项先单选；已选项保留整组。
                        if (!selectedPaths.includes(file.path)) {
                          setBrowserSelection(connectionId, file.path);
                        }
                        setContextMenu({ x: event.clientX, y: event.clientY, item: file });
                      }}
                      className={`grid cursor-pointer grid-cols-[1.5rem_minmax(0,4.4fr)_minmax(0,2fr)_minmax(5.5rem,1.2fr)_minmax(11.5rem,1.8fr)] gap-3 rounded-sm px-3 py-2 transition-colors group ${
                        isSelected
                          ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
                          : 'hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]'
                      }`}
                    >
                      <div
                        className="flex items-center justify-center"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleBrowserSelection(connectionId, file.path);
                        }}
                      >
                        <input type="checkbox" checked={isSelected} readOnly />
                      </div>
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

            {contextMenu && (
              <div
                ref={contextMenuRef}
                className="app-popover fixed top-auto z-50 mt-0 min-w-[168px] py-1"
                style={{
                  left: contextMenuPosition.x,
                  top: contextMenuPosition.y,
                }}
              >
                {contextMenu.item.isDirectory ? (
                  <button
                    type="button"
                    onClick={() => {
                      const item = contextMenu.item;
                      setContextMenu(null);
                      navigateTo(item.path);
                    }}
                    className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
                  >
                    <FolderOpen className="h-4 w-4" />
                    {t('fileTransfer.open')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const item = contextMenu.item;
                      setContextMenu(null);
                      void handleDownload(item);
                    }}
                    className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
                  >
                    <Download className="h-4 w-4" />
                    {t('common.download')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openRenameDialog(contextMenu.item)}
                  className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
                >
                  <Pencil className="h-4 w-4" />
                  {t('fileTransfer.rename')}
                </button>
                <div className="my-1 border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)]" />
                <button
                  type="button"
                  onClick={() => {
                    const targets = selectedPaths.includes(contextMenu.item.path) && selectedFiles.length > 1
                      ? selectedFiles
                      : [contextMenu.item];
                    setDeleteTargets(targets);
                    setContextMenu(null);
                  }}
                  className="app-popover-row text-sm text-red-600 dark:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                  {t('common.delete')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_56%,var(--bg-secondary))] p-2.5 text-xs text-slate-500 dark:text-slate-400">
        {activeView === 'tasks' ? (
          <span>{t('fileTransfer.taskCount', { count: visibleTransferTasks.length })}</span>
        ) : (
          <span>
            {selectedPaths.length > 0
              ? t('fileTransfer.selectedCount', { count: selectedPaths.length })
              : t('fileTransfer.itemCount', { count: files.length })}
          </span>
        )}
        <span className="tabular-nums">
          {activeTaskCount > 0
            ? t('fileTransfer.activeTaskCount', { count: activeTaskCount })
            : 'SFTP'}
        </span>
      </div>

      <Modal
        isOpen={renameTarget != null}
        onClose={() => {
          if (!isRenaming) {
            setRenameTarget(null);
            setRenameError(null);
          }
        }}
        title={t('fileTransfer.renameTitle')}
        size="sm"
        closeLabel={t('common.close')}
        initialFocusRef={renameInputRef}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleRename();
          }}
        >
          <div className="space-y-2 p-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              {t('fileTransfer.renameLabel')}
            </label>
            <input
              ref={renameInputRef}
              value={renameName}
              onChange={(event) => {
                setRenameName(event.target.value);
                setRenameError(null);
              }}
              className="industrial-input w-full"
              disabled={isRenaming}
            />
            {renameError && (
              <p className="text-xs text-red-600 dark:text-red-400">{renameError}</p>
            )}
          </div>
          <div className="industrial-modal-footer">
            <button
              type="button"
              onClick={() => setRenameTarget(null)}
              className="industrial-button-secondary"
              disabled={isRenaming}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="industrial-button-primary"
              disabled={isRenaming}
            >
              {isRenaming ? t('common.loading') : t('common.confirm')}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={mkdirOpen}
        onClose={() => {
          if (!isCreatingDir) {
            setMkdirOpen(false);
            setMkdirError(null);
          }
        }}
        title={t('fileTransfer.mkdirTitle')}
        size="sm"
        closeLabel={t('common.close')}
        initialFocusRef={mkdirInputRef}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleMkdir();
          }}
        >
          <div className="space-y-2 p-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              {t('fileTransfer.mkdirLabel')}
            </label>
            <input
              ref={mkdirInputRef}
              value={mkdirName}
              onChange={(event) => {
                setMkdirName(event.target.value);
                setMkdirError(null);
              }}
              className="industrial-input w-full"
              disabled={isCreatingDir}
            />
            {mkdirError && (
              <p className="text-xs text-red-600 dark:text-red-400">{mkdirError}</p>
            )}
          </div>
          <div className="industrial-modal-footer">
            <button
              type="button"
              onClick={() => setMkdirOpen(false)}
              className="industrial-button-secondary"
              disabled={isCreatingDir}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="industrial-button-primary"
              disabled={isCreatingDir}
            >
              {isCreatingDir ? t('common.loading') : t('common.confirm')}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={deleteTargets.length > 0}
        title={t('fileTransfer.deleteTitle')}
        message={deleteMessage}
        confirmText={isDeleting ? t('common.loading') : t('common.delete')}
        isConfirming={isDeleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          if (!isDeleting) {
            setDeleteTargets([]);
          }
        }}
      />

      <SftpConflictDialog
        isOpen={conflictTask != null}
        isSubmitting={isResolvingConflict}
        task={conflictTask}
        translate={t}
        onCancel={() => {
          if (!conflictTask || isResolvingConflict) return;
          void handleTaskAction('cancel', conflictTask.taskId);
        }}
        onResolve={(input) => {
          if (!conflictTask) return;
          setIsResolvingConflict(true);
          void transferController.resolveConflict({
            taskId: conflictTask.taskId,
            attempt: conflictTask.attempt,
            policy: input.policy,
            renamedPath: input.renamedPath,
            applyToBatch: input.applyToBatch,
          }).then((errorMessage) => {
            if (errorMessage) setActionError(errorMessage);
          }).finally(() => {
            setIsResolvingConflict(false);
          });
        }}
      />
    </div>
  );
}
