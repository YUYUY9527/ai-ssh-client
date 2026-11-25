import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Archive,
  ArrowRightLeft,
  Bookmark,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FileCode2,
  Folder,
  FolderArchive,
  FolderDown,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Globe,
  Home,
  Link2,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Shield,
  Trash2,
  Upload,
  UserCog,
  X,
} from 'lucide-react';

import { ConfirmDialog } from './ConfirmDialog';
import { FileTypeIcon } from './FileTypeIcon';
import { useI18n } from '../i18n';
import { normalizeHistoryPath } from '../history/command-history-index';
import { useSessionStore } from '../session/useSessionStore';
import { Modal } from '../shared-ui/Modal';
import { useSessionOverlay } from '../workspace/SessionOverlayContext';
import {
  useSftpTransferStore,
} from '../store/useSftpTransferStore';
import { SftpFileEditor } from '../transfer/SftpFileEditor';
import { CrossServerTransferModal } from '../transfer/CrossServerTransferModal';
import { FilePreviewModal } from '../transfer/FilePreviewModal';
import { RemoteSearchPanel } from '../transfer/RemoteSearchPanel';
import { previewKind } from '../transfer/file-preview';
import { TransferTaskList } from '../transfer/TransferTaskList';
import { useSftpTransferController } from '../transfer/useSftpTransferController';
import {
  DEFAULT_REMOTE_PATH,
  type RemoteFileItem,
} from '../transfer/transfer-types';
import { MAX_SFTP_EDIT_BYTES, type SftpConflictPolicy } from '../../shared/ipc-types';

/**
 * 是否展示「预览」入口 / 双击直接预览：
 * - 图片 / PDF 需要 base64 预览能力（previewSftpFile）；
 * - 音视频需要流式预览 URL 能力（getSftpMediaPreviewUrl，仅 Web 端）；
 * 桌面端缺对应方法时自动不展示，保持零回归。
 */
function canPreviewRemoteFile(name: string): boolean {
  const kind = previewKind(name);
  if (kind === 'image' || kind === 'pdf') {
    return typeof window.electronAPI?.previewSftpFile === 'function';
  }
  if (kind === 'video' || kind === 'audio') {
    return typeof window.electronAPI?.getSftpMediaPreviewUrl === 'function';
  }
  return false;
}

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

/**
 * 将列表中的 mode 规范为权限位 0–0o7777。
 * 桌面端多为八进制字符串（如 100644），Web 端 ssh2 常为十进制（如 33188）。
 */
function modeToPermissionBits(mode?: string): number {
  if (mode == null || !String(mode).trim()) {
    return 0o644;
  }
  const raw = String(mode).trim();
  // 含 8/9 只能是十进制
  if (/[89]/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? (n & 0o7777) : 0o644;
  }
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? (n & 0o7777) : 0o644;
}

/** 权限位格式化为 3–4 位八进制字符串。 */
function permissionBitsToOctal(bits: number): string {
  return (bits & 0o7777).toString(8).padStart(3, '0');
}

/** 解析用户输入的八进制权限。 */
function parseOctalPermissionInput(raw: string): number | null {
  const value = raw.trim().toLowerCase().replace(/^0o/, '');
  if (!/^[0-7]{1,4}$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 8) & 0o7777;
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

/** 解析地址栏输入：父目录 + 末段前缀，供路径补全使用。 */
function splitPathForSuggest(rawPath: string): { parent: string; fragment: string } {
  const normalized = rawPath.replace(/\\/g, '/');
  const trimmedEnd = normalized.replace(/\s+$/, '');
  if (!trimmedEnd.trim()) {
    return { parent: DEFAULT_REMOTE_PATH, fragment: '' };
  }
  // 以 / 结尾：列出该目录下全部子目录
  if (trimmedEnd.endsWith('/')) {
    return { parent: normalizeRemoteBrowsePath(trimmedEnd), fragment: '' };
  }
  const lastSlash = trimmedEnd.lastIndexOf('/');
  if (lastSlash < 0) {
    return { parent: DEFAULT_REMOTE_PATH, fragment: trimmedEnd.trim() };
  }
  if (lastSlash === 0) {
    return { parent: '/', fragment: trimmedEnd.slice(1) };
  }
  // ~/ 单独一段
  if (trimmedEnd.startsWith('~/') && lastSlash === 1) {
    return { parent: DEFAULT_REMOTE_PATH, fragment: trimmedEnd.slice(2) };
  }
  return {
    parent: normalizeRemoteBrowsePath(trimmedEnd.slice(0, lastSlash)),
    fragment: trimmedEnd.slice(lastSlash + 1),
  };
}

interface PathSuggestion {
  path: string;
  name: string;
  /** history = 近期访问；dir = 目录列举 */
  source: 'dir' | 'history';
}

/** 按前缀过滤目录项，优先 startsWith。 */
function filterDirectorySuggestions(
  candidates: RemoteFileItem[],
  fragment: string,
): PathSuggestion[] {
  const frag = fragment.toLowerCase();
  return candidates
    .filter((item) => item.isDirectory)
    .filter((item) => {
      if (!frag) return true;
      return item.name.toLowerCase().startsWith(frag) || item.name.toLowerCase().includes(frag);
    })
    .sort((left, right) => {
      if (!frag) return left.name.localeCompare(right.name);
      const leftStarts = left.name.toLowerCase().startsWith(frag) ? 0 : 1;
      const rightStarts = right.name.toLowerCase().startsWith(frag) ? 0 : 1;
      if (leftStarts !== rightStarts) return leftStarts - rightStarts;
      return left.name.localeCompare(right.name);
    })
    .slice(0, 12)
    .map((item) => ({ path: item.path, name: item.name, source: 'dir' as const }));
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

/** 列表里只显示 月/日 时:分，省掉年份和秒，给名称留更多空间 */
function formatListTime(timestamp: number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把八进制/十进制 mode 统一成 rwx 形式（如 rw-r--r-- (644)） */
function formatPermissions(mode?: string): string {
  const raw = (mode ?? '').trim();
  if (!raw) return '';
  if (!/^[0-9]+$/.test(raw)) return raw;
  const perms = modeToPermissionBits(raw) & 0o777;
  const flags = 'rwxrwxrwx';
  let symbolic = '';
  for (let index = 0; index < 9; index += 1) {
    symbolic += (perms >> (8 - index)) & 1 ? flags[index] : '-';
  }
  return `${symbolic} (${perms.toString(8).padStart(3, '0')})`;
}

/** Session-bound SFTP browser used inside the workspace sidebar. */
export function FileTransfer({ connectionId, isLive }: FileTransferProps) {
  const { t } = useI18n();
  const overlay = useSessionOverlay();
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
  const [pathFocused, setPathFocused] = useState(false);
  const [pathSuggestions, setPathSuggestions] = useState<PathSuggestion[]>([]);
  const [pathSuggestIndex, setPathSuggestIndex] = useState(0);
  const [pathSuggestLoading, setPathSuggestLoading] = useState(false);
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [files, setFiles] = useState<RemoteFileItem[]>([]);
  /** 当前目录内的名称过滤 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
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
  const [resolvingConflictTaskId, setResolvingConflictTaskId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<RemoteFileItem | null>(null);
  /** 文件过大等提示：居中弹窗，避免顶栏错误需滚动才可见 */
  const [editAlert, setEditAlert] = useState<string | null>(null);
  /** 远程图片/PDF 预览目标（仅 Web 端 previewSftpFile 可用时展示入口） */
  const [previewTarget, setPreviewTarget] = useState<RemoteFileItem | null>(null);
  /** 跨服务器传输目标文件（仅 Web 端 transferSftpFileCrossServer 可用时展示入口） */
  const [crossTransferTarget, setCrossTransferTarget] = useState<RemoteFileItem | null>(null);
  /** 远程搜索弹层开关（仅 Web 端 searchSftpFiles 可用时展示入口） */
  const [remoteSearchOpen, setRemoteSearchOpen] = useState(false);
  const [chmodTarget, setChmodTarget] = useState<RemoteFileItem | null>(null);
  const [chmodMode, setChmodMode] = useState('644');
  const [chmodError, setChmodError] = useState<string | null>(null);
  const [isChmodding, setIsChmodding] = useState(false);

  // 同机剪贴板（复制 / 剪切）、书签、压缩、软链接、修改属主
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'move'; paths: string[] } | null>(null);
  const [bookmarks, setBookmarks] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [archiveModal, setArchiveModal] = useState<{ names: string[]; archiveName: string; format: 'tar.gz' | 'zip' } | null>(null);
  const [symlinkModal, setSymlinkModal] = useState<{ targetPath: string; linkName: string } | null>(null);
  const [chownModal, setChownModal] = useState<{ item: RemoteFileItem; owner: string; group: string; recursive: boolean } | null>(null);
  const [opsBusy, setOpsBusy] = useState(false);

  const loadBookmarks = useCallback(async () => {
    if (!window.electronAPI?.listSftpBookmarks) return;
    const result = await window.electronAPI.listSftpBookmarks(connectionId);
    if (result.success) {
      setBookmarks(result.data.bookmarks || []);
    }
  }, [connectionId]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const isExtractableArchive = (name: string) => /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|zip)$/i.test(name);

  const handlePasteClipboard = async () => {
    if (!clipboard || !isLive) return;
    const api = clipboard.mode === 'move' ? window.electronAPI?.moveSftpItems : window.electronAPI?.copySftpItems;
    if (!api) return;
    setOpsBusy(true);
    try {
      const result = await api(connectionId, { sources: clipboard.paths, destinationDir: currentPath });
      if (!result.success) {
        setActionError(result.error);
      } else {
        if (clipboard.mode === 'move') setClipboard(null);
        await loadDirectory(currentPath);
      }
    } finally {
      setOpsBusy(false);
    }
  };

  const handleConfirmArchive = async () => {
    if (!archiveModal || !window.electronAPI?.archiveSftpItems) return;
    setOpsBusy(true);
    try {
      const result = await window.electronAPI.archiveSftpItems(connectionId, {
        baseDir: currentPath,
        names: archiveModal.names,
        archiveName: archiveModal.archiveName,
        format: archiveModal.format,
      });
      if (!result.success) {
        setActionError(result.error);
      } else {
        setArchiveModal(null);
        await loadDirectory(currentPath);
      }
    } finally {
      setOpsBusy(false);
    }
  };

  const handleExtractArchive = async (item: RemoteFileItem) => {
    if (!window.electronAPI?.extractSftpArchive) return;
    setOpsBusy(true);
    try {
      const result = await window.electronAPI.extractSftpArchive(connectionId, {
        archivePath: item.path,
        destinationDir: currentPath,
      });
      if (!result.success) {
        setActionError(result.error);
      } else {
        await loadDirectory(currentPath);
      }
    } finally {
      setOpsBusy(false);
    }
  };

  const handleConfirmSymlink = async () => {
    if (!symlinkModal || !window.electronAPI?.createSftpSymlink) return;
    const linkName = symlinkModal.linkName.trim();
    if (!linkName) return;
    const linkPath = linkName.startsWith('/')
      ? linkName
      : `${currentPath.replace(/\/+$/, '')}/${linkName}`;
    setOpsBusy(true);
    try {
      const result = await window.electronAPI.createSftpSymlink(connectionId, {
        targetPath: symlinkModal.targetPath,
        linkPath,
      });
      if (!result.success) {
        setActionError(result.error);
      } else {
        setSymlinkModal(null);
        await loadDirectory(currentPath);
      }
    } finally {
      setOpsBusy(false);
    }
  };

  const handleConfirmChown = async () => {
    if (!chownModal || !window.electronAPI?.chownSftpItem) return;
    setOpsBusy(true);
    try {
      const result = await window.electronAPI.chownSftpItem(connectionId, {
        remotePath: chownModal.item.path,
        owner: chownModal.owner.trim(),
        group: chownModal.group.trim() || undefined,
        recursive: chownModal.recursive,
      });
      if (!result.success) {
        setActionError(result.error);
      } else {
        setChownModal(null);
        await loadDirectory(currentPath);
      }
    } finally {
      setOpsBusy(false);
    }
  };

  const handleAddBookmark = async () => {
    if (!window.electronAPI?.saveSftpBookmark) return;
    const clean = currentPath || '/';
    const name = clean === '/' ? '/' : clean.split('/').filter(Boolean).pop() || clean;
    const result = await window.electronAPI.saveSftpBookmark({ connectionId, name, path: clean });
    if (result.success) {
      await loadBookmarks();
    }
  };

  const handleDeleteBookmark = async (bookmarkId: string) => {
    if (!window.electronAPI?.deleteSftpBookmark) return;
    await window.electronAPI.deleteSftpBookmark(bookmarkId);
    await loadBookmarks();
  };
  /** 复制路径等轻量成功提示 */
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  /** 路径编辑：合并到面包屑里，点击铅笔才展开输入框 */
  const [pathEditOpen, setPathEditOpen] = useState(false);
  /** 工具栏「更多」菜单 */
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  /** 悬停 2 秒后的文件详情浮层 */
  const [hoverDetail, setHoverDetail] = useState<{
    item: RemoteFileItem;
    x: number;
    y: number;
  } | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const mkdirInputRef = useRef<HTMLInputElement>(null);
  const chmodInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pathSuggestRef = useRef<HTMLDivElement>(null);
  const toolbarMenuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathListCacheRef = useRef<Map<string, RemoteFileItem[]>>(new Map());
  const statusNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathSuggestRequestRef = useRef(0);
  const refreshedUploadTasksRef = useRef<Set<string>>(new Set());
  const loadRequestRef = useRef(0);
  const handledNavigationVersionRef = useRef(navigationVersion);

  // 切走会话时收起瞬态浮层（右键菜单、更多菜单、悬停详情），保留编辑器/预览等会话状态
  useEffect(() => {
    if (overlay.isActive) return;
    setContextMenu(null);
    setToolbarMenuOpen(false);
    setHoverDetail(null);
  }, [overlay.isActive]);

  const visibleTransferTasks = useMemo(
    () => transferTasks
      .filter((task) => task.connectionId === connectionId)
      // 任务创建后保持稳定顺序；不能用 updatedAt 排序，否则每个进度事件都会让卡片跳位。
      .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId)),
    [connectionId, transferTasks],
  );
  const activeTaskCount = visibleTransferTasks.filter(
    (task) => !['completed', 'skipped', 'canceled', 'interrupted', 'failed', 'handed-off'].includes(task.status),
  ).length;
  const hasTransferTasks = visibleTransferTasks.length > 0;
  const visibleFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return files;
    return files.filter((file) => file.name.toLowerCase().includes(query));
  }, [files, searchQuery]);
  const selectedFiles = useMemo(
    () => files.filter((file) => selectedPaths.includes(file.path)),
    [files, selectedPaths],
  );
  const orderedPaths = useMemo(() => visibleFiles.map((file) => file.path), [visibleFiles]);
  const selectedHasDirectory = selectedFiles.some((file) => file.isDirectory);

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
        pathListCacheRef.current.set(resolvedPath, nextFiles);
        pathListCacheRef.current.set(targetPath, nextFiles);
        setPathHistory((prev) => {
          const next = [resolvedPath, ...prev.filter((item) => item !== resolvedPath)];
          return next.slice(0, 40);
        });
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

  const getFileIcon = (file: RemoteFileItem) => (
    <FileTypeIcon
      name={file.name}
      isDirectory={file.isDirectory}
      isSymbolicLink={file.isSymbolicLink}
    />
  );

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
      setPathSuggestions([]);
      return;
    }
    setPathSuggestions([]);
    setPathFocused(false);
    navigateTo(nextPath);
  }, [currentPath, error, files.length, navigateTo, pathInput]);

  /** 点击补全项：跳转完整目录路径。 */
  const applyPathSuggestion = useCallback((suggestion: PathSuggestion) => {
    setPathInput(suggestion.path);
    setPathSuggestions([]);
    setPathFocused(false);
    navigateTo(suggestion.path);
  }, [navigateTo]);

  const showPathSuggestions = pathFocused && pathSuggestions.length > 0 && isLive;

  // 路径补全：根据输入父目录列举子目录 + 近期访问路径
  useEffect(() => {
    if (!pathFocused || !isLive || activeView !== 'files') {
      return;
    }

    const { parent, fragment } = splitPathForSuggest(pathInput);
    const parentKey = normalizeRemoteBrowsePath(parent);
    const requestId = ++pathSuggestRequestRef.current;

    const mergeWithHistory = (dirItems: PathSuggestion[]): PathSuggestion[] => {
      const inputLower = pathInput.trim().toLowerCase();
      const historyHits = pathHistory
        .filter((item) => {
          if (!inputLower) return item !== normalizeRemoteBrowsePath(currentPath);
          return item.toLowerCase().includes(inputLower) && item.toLowerCase() !== inputLower;
        })
        .slice(0, 6)
        .map((item) => ({
          path: item,
          name: item,
          source: 'history' as const,
        }));
      const seen = new Set<string>();
      const merged: PathSuggestion[] = [];
      for (const item of [...dirItems, ...historyHits]) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        merged.push(item);
      }
      return merged.slice(0, 14);
    };

    const applyCandidates = (candidates: RemoteFileItem[]) => {
      if (requestId !== pathSuggestRequestRef.current) return;
      const dirs = filterDirectorySuggestions(candidates, fragment);
      setPathSuggestions(mergeWithHistory(dirs));
      setPathSuggestIndex(0);
      setPathSuggestLoading(false);
    };

    // 当前目录可直接用已加载列表
    if (parentKey === normalizeRemoteBrowsePath(currentPath) && files.length > 0) {
      applyCandidates(files);
      return;
    }

    const cached = pathListCacheRef.current.get(parentKey);
    if (cached) {
      applyCandidates(cached);
      return;
    }

    setPathSuggestLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        if (!window.electronAPI || requestId !== pathSuggestRequestRef.current) {
          return;
        }
        try {
          const result = await window.electronAPI.listDirectory(connectionId, parentKey);
          if (requestId !== pathSuggestRequestRef.current) {
            return;
          }
          if (result.success && result.data?.files) {
            const listed = result.data.files;
            const resolvedParent = normalizeRemoteBrowsePath(result.data.path || parentKey);
            pathListCacheRef.current.set(parentKey, listed);
            pathListCacheRef.current.set(resolvedParent, listed);
            applyCandidates(listed);
            return;
          }
          setPathSuggestions(mergeWithHistory([]));
          setPathSuggestIndex(0);
        } catch {
          if (requestId === pathSuggestRequestRef.current) {
            setPathSuggestions(mergeWithHistory([]));
          }
        } finally {
          if (requestId === pathSuggestRequestRef.current) {
            setPathSuggestLoading(false);
          }
        }
      })();
    }, 180);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeView, connectionId, currentPath, files, isLive, pathFocused, pathHistory, pathInput]);

  // 点击补全面板外关闭（同时退出路径编辑态，避免输入框悬空卡住）
  useEffect(() => {
    if (!pathFocused && !pathEditOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (pathInputRef.current?.contains(target) || pathSuggestRef.current?.contains(target)) {
        return;
      }
      setPathFocused(false);
      setPathEditOpen(false);
      setPathInput(currentPath);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [currentPath, pathEditOpen, pathFocused]);

  // 打开路径编辑时自动聚焦并全选
  useEffect(() => {
    if (!pathEditOpen) return;
    const timer = window.setTimeout(() => {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pathEditOpen]);

  // 工具栏「更多」菜单：点击外部或 Esc 关闭
  useEffect(() => {
    if (!toolbarMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (toolbarMenuRef.current && !toolbarMenuRef.current.contains(event.target as Node)) {
        setToolbarMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setToolbarMenuOpen(false);
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [toolbarMenuOpen]);

  // 悬停详情：卸载时清理定时器；列表滚动时收起浮层
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  useEffect(() => {
    if (!hoverDetail) return;
    const hide = () => setHoverDetail(null);
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [hoverDetail]);

  // 切换目录/会话时清空过滤，避免误以为目录里文件缺失。
  useEffect(() => {
    setSearchQuery('');
  }, [currentPath, connectionId]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

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

  const openFileForEdit = (file: RemoteFileItem) => {
    if (typeof file.size === 'number' && file.size > MAX_SFTP_EDIT_BYTES) {
      setEditAlert(t('fileTransfer.editTooLarge', {
        size: formatSize(file.size),
        max: formatSize(MAX_SFTP_EDIT_BYTES),
      }));
      return;
    }
    setEditTarget(file);
  };

  const handleItemDoubleClick = (file: RemoteFileItem) => {
    if (file.isDirectory) {
      navigateTo(file.path);
      return;
    }
    // 图片/PDF/音视频双击直接预览，避免落入文本编辑器报「非 UTF-8」错误。
    if (canPreviewRemoteFile(file.name)) {
      setPreviewTarget(file);
      return;
    }
    openFileForEdit(file);
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

  /** 短暂底部提示（复制路径成功等）。 */
  const showStatusNotice = useCallback((message: string) => {
    setStatusNotice(message);
    if (statusNoticeTimerRef.current) {
      clearTimeout(statusNoticeTimerRef.current);
    }
    statusNoticeTimerRef.current = setTimeout(() => {
      setStatusNotice(null);
      statusNoticeTimerRef.current = null;
    }, 1600);
  }, []);

  useEffect(() => () => {
    if (statusNoticeTimerRef.current) {
      clearTimeout(statusNoticeTimerRef.current);
    }
  }, []);

  /** 复制远端路径到剪贴板。 */
  const handleCopyPath = async (item: RemoteFileItem) => {
    setContextMenu(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(item.path);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = item.path;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      showStatusNotice(t('fileTransfer.pathCopied'));
    } catch {
      setEditAlert(t('fileTransfer.copyPathFailed'));
    }
  };

  /** 打开权限编辑弹窗。 */
  const openChmodDialog = (item: RemoteFileItem) => {
    setContextMenu(null);
    setChmodTarget(item);
    setChmodMode(permissionBitsToOctal(modeToPermissionBits(item.mode)));
    setChmodError(null);
  };

  /** 切换某一 rwx 位。 */
  const toggleChmodBit = (mask: number) => {
    const current = parseOctalPermissionInput(chmodMode) ?? 0;
    const next = (current & mask) === mask ? (current & ~mask) : (current | mask);
    setChmodMode(permissionBitsToOctal(next));
    setChmodError(null);
  };

  /** 提交 chmod。 */
  const handleChmod = async () => {
    if (!chmodTarget || isChmodding) {
      return;
    }
    const mode = parseOctalPermissionInput(chmodMode);
    if (mode == null) {
      setChmodError(t('fileTransfer.permissionsInvalid'));
      return;
    }
    if (!window.electronAPI?.setSftpPermissions) {
      setChmodError(t('fileTransfer.permissionsFailed'));
      return;
    }
    setIsChmodding(true);
    setChmodError(null);
    try {
      const result = await window.electronAPI.setSftpPermissions(
        connectionId,
        chmodTarget.path,
        mode,
      );
      if (!result.success) {
        setChmodError(result.error || t('fileTransfer.permissionsFailed'));
        return;
      }
      setChmodTarget(null);
      await loadDirectory(currentPath);
    } catch (err) {
      setChmodError((err as Error).message || t('fileTransfer.permissionsFailed'));
    } finally {
      setIsChmodding(false);
    }
  };

  useEffect(() => {
    if (!chmodTarget) {
      return;
    }
    const frame = requestAnimationFrame(() => chmodInputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [chmodTarget]);

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

  const handleUploadFolder = async () => {
    if (!isLive) return;
    const errorMessage = await transferController.uploadFolder();
    if (errorMessage) setActionError(errorMessage);
  };

  const handleDownloadFolder = async (folder: RemoteFileItem) => {
    if (!isLive) return;
    const errorMessage = await transferController.downloadFolder(folder.path);
    if (errorMessage) setActionError(errorMessage);
  };

  const handleTaskAction = async (
    action: 'cancel' | 'retry' | 'discard' | 'remove' | 'pause' | 'resume',
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
        : action === 'pause'
          ? transferController.pause
          : action === 'resume'
            ? transferController.resume
            : transferController.discard;
    const errorMessage = await runner(taskId);
    if (errorMessage) setActionError(errorMessage);
    if (action === 'discard') {
      removeTransferTask(taskId);
    }
  };

  const handlePauseAll = async () => {
    const errorMessage = await transferController.pauseAll();
    if (errorMessage) setActionError(errorMessage);
  };

  const handleResumeAll = async () => {
    const errorMessage = await transferController.resumeAll();
    if (errorMessage) setActionError(errorMessage);
  };

  const handleResolveConflict = async (
    taskId: string,
    policy: Exclude<SftpConflictPolicy, 'ask'>,
    renamedPath?: string,
    applyToBatch?: boolean,
  ) => {
    const task = transferTasks.find((item) => item.taskId === taskId);
    if (!task || resolvingConflictTaskId) return;
    setResolvingConflictTaskId(taskId);
    try {
      const errorMessage = await transferController.resolveConflict({
        taskId,
        attempt: task.attempt,
        policy,
        renamedPath,
        applyToBatch,
      });
      if (errorMessage) setActionError(errorMessage);
    } finally {
      setResolvingConflictTaskId(null);
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

  // 路径输入框：合并到面包屑行，点铅笔才展开
  const pathEditor = (
    <div className="relative min-w-0 flex-1">
      <input
        ref={pathInputRef}
        type="text"
        value={pathInput}
        onChange={(e) => {
          setPathInput(e.target.value);
          setPathFocused(true);
        }}
        onFocus={() => setPathFocused(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && showPathSuggestions) {
            e.preventDefault();
            setPathSuggestIndex((index) => Math.min(index + 1, pathSuggestions.length - 1));
            return;
          }
          if (e.key === 'ArrowUp' && showPathSuggestions) {
            e.preventDefault();
            setPathSuggestIndex((index) => Math.max(index - 1, 0));
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setPathSuggestions([]);
            setPathFocused(false);
            setPathEditOpen(false);
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (showPathSuggestions && pathSuggestions[pathSuggestIndex]) {
              applyPathSuggestion(pathSuggestions[pathSuggestIndex]);
              setPathEditOpen(false);
              return;
            }
            commitPathInput();
            setPathEditOpen(false);
          }
        }}
        className="industrial-input w-full py-1"
        placeholder={t('fileTransfer.pathPlaceholder')}
        disabled={!isLive}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={showPathSuggestions}
        aria-autocomplete="list"
        aria-controls="sftp-path-suggestions"
      />
      {pathFocused && isLive && (showPathSuggestions || pathSuggestLoading) && (
        <div
          ref={pathSuggestRef}
          id="sftp-path-suggestions"
          role="listbox"
          className="app-popover scrollbar-thin left-0 right-0 top-full z-popover mt-1 max-h-56 overflow-y-auto py-1"
        >
          {pathSuggestLoading && pathSuggestions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-fg-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading')}
            </div>
          ) : pathSuggestions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-muted">
              {t('fileTransfer.pathNoMatches')}
            </div>
          ) : (
            pathSuggestions.map((item, index) => (
              <button
                key={`${item.source}-${item.path}`}
                type="button"
                role="option"
                aria-selected={index === pathSuggestIndex}
                className={`app-popover-row w-full gap-2 px-3 py-1.5 text-left text-sm ${
                  index === pathSuggestIndex
                    ? 'bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)]'
                    : ''
                }`}
                onMouseEnter={() => setPathSuggestIndex(index)}
                onMouseDown={(event) => {
                  // 避免 input blur 先于 click 关掉列表
                  event.preventDefault();
                  applyPathSuggestion(item);
                  setPathEditOpen(false);
                }}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                  {item.path}
                </span>
                {item.source === 'history' && (
                  <span className="shrink-0 text-[10px] text-fg-muted">
                    {t('fileTransfer.pathRecent')}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color-mix(in_srgb,var(--bg-primary)_76%,var(--bg-secondary))]">
      <div className="relative flex flex-wrap items-center gap-0.5 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_48%,var(--bg-secondary))] px-1.5 py-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => setBrowserView(connectionId, 'files')}
            className={`icon-button h-7 w-7 ${
              activeView === 'files'
                ? 'bg-[color-mix(in_srgb,var(--accent-primary)_20%,transparent)] text-accent'
                : 'text-fg-muted'
            }`}
            title={t('fileTransfer.files')}
          >
            <Folder className="h-4 w-4" />
          </button>
          <span
            aria-hidden="true"
            className="mx-0.5 h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--border-color)_85%,transparent)]"
          />
          <button
            onClick={() => setBrowserView(connectionId, 'tasks')}
            className={`icon-button relative h-7 w-7 ${
              activeView === 'tasks'
                ? 'bg-[color-mix(in_srgb,var(--accent-primary)_20%,transparent)] text-accent'
                : 'text-fg-muted'
            }`}
            title={t('fileTransfer.transferTasks')}
          >
            <ListChecks className="h-4 w-4" />
            {hasTransferTasks && (
              <span className="absolute -right-0.5 -top-0.5 rounded-full bg-accent px-1 text-[9px] font-semibold leading-3 text-white tabular-nums">
                {activeTaskCount > 0 ? activeTaskCount : visibleTransferTasks.length}
              </span>
            )}
          </button>
        </div>

        {activeView === 'files' && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={goHome}
              className="icon-button h-7 w-7"
              title={t('fileTransfer.homeDir')}
              disabled={!isLive}
            >
              <Home className="h-4 w-4" />
            </button>
            <button
              onClick={goUp}
              className="icon-button h-7 w-7"
              title={t('fileTransfer.parentDir')}
              disabled={!isLive}
            >
              <ChevronRight className="h-4 w-4 rotate-180" />
            </button>
            <button
              onClick={() => void loadDirectory(pathInput || currentPath)}
              className="icon-button h-7 w-7"
              title={t('common.refresh')}
              disabled={!isLive}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => {
                if (searchOpen) {
                  setSearchOpen(false);
                  setSearchQuery('');
                } else {
                  setSearchOpen(true);
                }
              }}
              className={`icon-button h-7 w-7 ${searchOpen ? 'text-accent' : ''}`}
              title={t('fileTransfer.searchFiles')}
              aria-pressed={searchOpen}
              disabled={!isLive}
            >
              <Search className="h-4 w-4" />
            </button>
            {typeof window.electronAPI?.listSftpBookmarks === 'function' && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBookmarksOpen((prev) => !prev)}
                  className={`icon-button h-7 w-7 ${bookmarksOpen ? 'text-accent' : ''}`}
                  title={t('fileTransfer.bookmarks.title')}
                  disabled={!isLive}
                >
                  <Bookmark className="h-4 w-4" />
                </button>
                {bookmarksOpen && (
                  <div className="app-popover left-0 top-full z-dropdown mt-1 w-64 space-y-1.5 p-2">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <span className="text-xs font-semibold text-fg">{t('fileTransfer.bookmarks.title')}</span>
                      <button
                        type="button"
                        onClick={() => void handleAddBookmark()}
                        className="text-[11px] font-medium text-accent hover:text-accent-hover"
                      >
                        + {t('fileTransfer.bookmarks.addCurrent')}
                      </button>
                    </div>
                    {bookmarks.length === 0 ? (
                      <p className="px-1 py-2 text-xs text-fg-muted">{t('fileTransfer.bookmarks.empty')}</p>
                    ) : (
                      <div className="max-h-52 space-y-0.5 overflow-y-auto scrollbar-thin">
                        {bookmarks.map((bm) => (
                          <div key={bm.id} className="group flex items-center gap-1 rounded-sm hover:bg-surface-hover">
                            <button
                              type="button"
                              onClick={() => {
                                setBookmarksOpen(false);
                                void loadDirectory(bm.path);
                              }}
                              className="min-w-0 flex-1 px-2 py-1 text-left"
                            >
                              <div className="truncate text-xs font-medium text-fg">{bm.name}</div>
                              <div className="truncate font-mono text-[10px] text-fg-muted">{bm.path}</div>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteBookmark(bm.id)}
                              className="icon-button h-6 w-6 opacity-0 group-hover:opacity-100 hover:text-danger"
                              title={t('common.delete')}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {clipboard && (
              <button
                type="button"
                onClick={() => void handlePasteClipboard()}
                disabled={!isLive || opsBusy}
                className="icon-button h-7 px-1.5 text-xs text-accent"
                title={t('fileTransfer.ops.pasteHere', { count: clipboard.paths.length })}
              >
                <ClipboardPaste className="h-3.5 w-3.5" />
                <span className="ml-0.5 font-mono text-[10px]">{clipboard.paths.length}</span>
              </button>
            )}
          </div>
        )}

        {activeView === 'tasks' && (
          <div className="flex-1" />
        )}

        {activeView === 'tasks' ? (
          <button
            onClick={() => clearCompletedTasks(connectionId)}
            className="industrial-button-secondary px-2 py-1 text-xs"
            disabled={!visibleTransferTasks.some((task) => ['completed', 'skipped', 'canceled', 'interrupted', 'failed', 'handed-off'].includes(task.status))}
          >
            {t('fileTransfer.clearFinished')}
          </button>
        ) : (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => void handleUpload()}
              className="icon-button h-7 w-7"
              title={t('common.upload')}
              disabled={!isLive}
            >
              <Upload className="h-4 w-4" />
            </button>
            <div className="relative" ref={toolbarMenuRef}>
              <button
                onClick={() => setToolbarMenuOpen((open) => !open)}
                className="icon-button h-7 w-7"
                title={t('fileTransfer.moreActions')}
                aria-haspopup="menu"
                aria-expanded={toolbarMenuOpen}
                disabled={!isLive}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {toolbarMenuOpen && (
                <div
                  role="menu"
                  className="app-popover absolute right-0 top-full z-popover mt-1 min-w-[168px] py-1"
                >
                  {typeof window.electronAPI?.searchSftpFiles === 'function' && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setToolbarMenuOpen(false);
                        setRemoteSearchOpen(prev => !prev);
                      }}
                      className="app-popover-row w-full gap-2 px-3 py-1.5 text-left text-sm"
                    >
                      <Globe className="h-4 w-4" />
                      {t('features.search.title')}
                    </button>
                  )}
                  {typeof window.electronAPI?.selectSftpFolder === 'function' && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setToolbarMenuOpen(false);
                        void handleUploadFolder();
                      }}
                      className="app-popover-row w-full gap-2 px-3 py-1.5 text-left text-sm"
                      disabled={!isLive}
                    >
                      <FolderUp className="h-4 w-4" />
                      {t('features.folderTransfer.uploadFolder')}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMenuOpen(false);
                      setMkdirOpen(true);
                      setMkdirName('');
                      setMkdirError(null);
                    }}
                    className="app-popover-row w-full gap-2 px-3 py-1.5 text-left text-sm"
                  >
                    <FolderPlus className="h-4 w-4" />
                    {t('fileTransfer.mkdir')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMenuOpen(false);
                      void handleBatchDownload();
                    }}
                    className="app-popover-row w-full gap-2 px-3 py-1.5 text-left text-sm"
                    disabled={!isLive || selectedFiles.length === 0 || selectedHasDirectory}
                  >
                    <Download className="h-4 w-4" />
                    {t('common.download')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMenuOpen(false);
                      if (selectedFiles.length === 0) return;
                      setDeleteTargets(selectedFiles);
                    }}
                    className="app-popover-row w-full gap-2 px-3 py-1.5 text-left text-sm"
                    disabled={!isLive || selectedFiles.length === 0}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {activeView !== 'tasks' && remoteSearchOpen && typeof window.electronAPI?.searchSftpFiles === 'function' && (
          <RemoteSearchPanel
            connectionId={connectionId}
            currentPath={currentPath}
            onNavigate={(path) => { void navigateTo(path); }}
            onClose={() => setRemoteSearchOpen(false)}
            translate={t}
          />
        )}
      </div>

      {activeView === 'files' && (
        <div className="flex items-center gap-1 border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_66%,var(--bg-secondary))] px-2 py-1 text-sm">
          {pathEditOpen ? (
            pathEditor
          ) : (
            <>
              <div className="file-path-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <button
                  onClick={() => navigateTo(pathRoot)}
                  className="whitespace-nowrap text-fg-muted hover:text-accent disabled:opacity-50"
                  disabled={!isLive}
                >
                  {pathRoot}
                </button>
                {pathParts.map((part, index) => (
                  <span key={`${part}-${index}`} className="flex items-center">
                    <ChevronRight className="mx-0.5 h-3 w-3 shrink-0 text-fg-subtle" />
                    <button
                      onClick={() => navigateTo(
                        `${isHomePath ? '~/' : '/'}${pathParts.slice(0, index + 1).join('/')}`,
                      )}
                      className="whitespace-nowrap text-fg-muted hover:text-accent disabled:opacity-50"
                      disabled={!isLive}
                    >
                      {part}
                    </button>
                  </span>
                ))}
              </div>
              {isLive && (
                <button
                  onClick={() => {
                    setPathInput(currentPath);
                    setPathEditOpen(true);
                  }}
                  className="icon-button h-6 w-6 shrink-0"
                  title={t('fileTransfer.editPath')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          )}
        </div>
      )}

      {activeView === 'files' && searchOpen && (
        <div className="flex items-center gap-1.5 border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setSearchOpen(false);
                setSearchQuery('');
              }
            }}
            placeholder={t('fileTransfer.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle dark:text-fg"
            spellCheck={false}
          />
          {searchQuery.trim() && (
            <span className="shrink-0 text-[10px] tabular-nums text-fg-muted">
              {visibleFiles.length}/{files.length}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              if (searchQuery) {
                setSearchQuery('');
                searchInputRef.current?.focus();
              } else {
                setSearchOpen(false);
              }
            }}
            className="icon-button h-6 w-6 shrink-0"
            title={searchQuery ? t('fileTransfer.searchClear') : t('common.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeView === 'tasks' ? (
          <TransferTaskList
            tasks={visibleTransferTasks}
            onCancelTask={(taskId) => void handleTaskAction('cancel', taskId)}
            onRetryTask={(taskId) => void handleTaskAction('retry', taskId)}
            onPauseTask={(taskId) => void handleTaskAction('pause', taskId)}
            onResumeTask={(taskId) => void handleTaskAction('resume', taskId)}
            onPauseAll={() => void handlePauseAll()}
            onResumeAll={() => void handleResumeAll()}
            onDiscardTask={(taskId) => void handleTaskAction('discard', taskId)}
            onRemoveTask={(taskId) => void handleTaskAction('remove', taskId)}
            onResolveConflict={(taskId, policy, renamedPath, applyToBatch) => {
              void handleResolveConflict(taskId, policy, renamedPath, applyToBatch);
            }}
            resolvingConflictTaskId={resolvingConflictTaskId}
            translate={t}
          />
        ) : (
          <div
            ref={dropZoneRef}
            className={`relative h-full overflow-hidden ${isDragOver ? 'bg-accent-muted ring-2 ring-inset ring-accent' : ''}`}
          >
            <div className="file-transfer-scroll h-full overflow-y-auto p-2">
            {actionError && (
              <div className="mb-2 flex items-center gap-2 rounded-sm border border-[color-mix(in_srgb,var(--danger)_45%,var(--border-color))] bg-danger-muted px-3 py-2 text-xs text-danger-fg">
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
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-fg-muted">
                <AlertCircle className="h-6 w-6 text-warning" />
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
                <Loader2 className="h-8 w-8 animate-spin text-accent" />
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="flex items-center text-danger">
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
              <div className="flex h-full flex-col items-center justify-center text-fg-subtle">
                <Folder className="mb-2 h-12 w-12 opacity-50" />
                <p className="text-sm">{t('fileTransfer.emptyDir')}</p>
                <p className="mt-1 text-xs">{t('fileTransfer.dragHint')}</p>
              </div>
            ) : visibleFiles.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-fg-subtle">
                <Search className="h-8 w-8 opacity-50" />
                <p className="text-sm">{t('fileTransfer.searchEmpty')}</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {visibleFiles.map((file) => {
                  const isSelected = selectedPaths.includes(file.path);
                  return (
                    <div
                      key={file.path}
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        setHoverDetail(null);
                        handleItemClick(event, file);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          handleItemDoubleClick(file);
                        }
                      }}
                      onDoubleClick={() => handleItemDoubleClick(file)}
                      onMouseEnter={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                        hoverTimerRef.current = setTimeout(() => {
                          const width = 264;
                          const height = 224;
                          const x = Math.max(8, Math.min(rect.left + 8, window.innerWidth - width - 8));
                          const y = rect.bottom + 6 + height > window.innerHeight
                            ? Math.max(8, rect.top - height - 6)
                            : rect.bottom + 6;
                          setHoverDetail({ item: file, x, y });
                        }, 2000);
                      }}
                      onMouseLeave={() => {
                        if (hoverTimerRef.current) {
                          clearTimeout(hoverTimerRef.current);
                          hoverTimerRef.current = null;
                        }
                        setHoverDetail(null);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setHoverDetail(null);
                        // 右键未选项先单选；已选项保留整组。
                        if (!selectedPaths.includes(file.path)) {
                          setBrowserSelection(connectionId, file.path);
                        }
                        setContextMenu({ x: event.clientX, y: event.clientY, item: file });
                      }}
                      className={`sftp-file-row group grid cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 transition-colors ${
                        isSelected
                          ? 'bg-[color-mix(in_srgb,var(--accent-primary)_22%,transparent)]'
                          : 'hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {getFileIcon(file)}
                        <span className="truncate text-sm text-fg" title={file.name}>
                          {file.name}
                        </span>
                      </div>
                      <div className="sftp-file-size whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-fg-subtle">
                        {file.isDirectory ? '—' : formatSize(file.size)}
                      </div>
                      <div className="whitespace-nowrap text-right text-xs tabular-nums text-fg-muted">
                        {formatListTime(file.mtime)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </div>

            {isDragOver && (
              <div className="pointer-events-none absolute inset-0 z-raised flex items-center justify-center rounded-sm border-2 border-dashed border-accent bg-[color-mix(in_srgb,var(--accent-primary)_14%,var(--bg-secondary))]">
                <div className="rounded-md bg-surface-elevated px-3.5 py-2 text-xs font-semibold text-accent shadow-md">
                  {t('fileTransfer.dropHint')}
                </div>
              </div>
            )}

            {contextMenu && typeof document !== 'undefined' && createPortal(
              <div
                ref={contextMenuRef}
                role="menu"
                className="app-popover fixed top-auto z-overlay mt-0 min-w-[168px] py-1"
                style={{
                  left: contextMenuPosition.x,
                  top: contextMenuPosition.y,
                }}
              >
                {contextMenu.item.isDirectory ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const item = contextMenu.item;
                        setContextMenu(null);
                        navigateTo(item.path);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                    >
                      <FolderOpen className="h-4 w-4" />
                      {t('fileTransfer.open')}
                    </button>
                    {typeof window.electronAPI?.listSftpFolderFiles === 'function' && (
                      <button
                        type="button"
                        onClick={() => {
                          const item = contextMenu.item;
                          setContextMenu(null);
                          void handleDownloadFolder(item);
                        }}
                        className="app-popover-row text-sm text-fg-secondary"
                      >
                        <FolderDown className="h-4 w-4" />
                        {t('features.folderTransfer.downloadFolder')}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const item = contextMenu.item;
                        setContextMenu(null);
                        openFileForEdit(item);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                    >
                      <FileCode2 className="h-4 w-4" />
                      {t('fileTransfer.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const item = contextMenu.item;
                        setContextMenu(null);
                        void handleDownload(item);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                    >
                      <Download className="h-4 w-4" />
                      {t('common.download')}
                    </button>
                    {typeof window.electronAPI?.transferSftpFileCrossServer === 'function' && (
                      <button
                        type="button"
                        onClick={() => {
                          const item = contextMenu.item;
                          setContextMenu(null);
                          setCrossTransferTarget(item);
                        }}
                        className="app-popover-row text-sm text-fg-secondary"
                        disabled={!isLive}
                      >
                        <ArrowRightLeft className="h-4 w-4" />
                        {t('fileTransfer.crossServer.menuAction')}
                      </button>
                    )}
                    {canPreviewRemoteFile(contextMenu.item.name) && (
                      <button
                        type="button"
                        onClick={() => {
                          const item = contextMenu.item;
                          setContextMenu(null);
                          setPreviewTarget(item);
                        }}
                        className="app-popover-row text-sm text-fg-secondary"
                      >
                        <Eye className="h-4 w-4" />
                        {t('features.preview.title')}
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => openRenameDialog(contextMenu.item)}
                  className="app-popover-row text-sm text-fg-secondary"
                >
                  <Pencil className="h-4 w-4" />
                  {t('fileTransfer.rename')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyPath(contextMenu.item)}
                  className="app-popover-row text-sm text-fg-secondary"
                >
                  <Copy className="h-4 w-4" />
                  {t('fileTransfer.copyPath')}
                </button>
                <button
                  type="button"
                  onClick={() => openChmodDialog(contextMenu.item)}
                  className="app-popover-row text-sm text-fg-secondary"
                  disabled={!isLive}
                >
                  <Shield className="h-4 w-4" />
                  {t('fileTransfer.permissions')}
                </button>
                {typeof window.electronAPI?.copySftpItems === 'function' && (
                  <>
                    <div className="my-1 border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)]" />
                    <button
                      type="button"
                      onClick={() => {
                        const targets = selectedPaths.includes(contextMenu.item.path) && selectedFiles.length > 1
                          ? selectedFiles.map((item) => item.path)
                          : [contextMenu.item.path];
                        setClipboard({ mode: 'copy', paths: targets });
                        setContextMenu(null);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                      disabled={!isLive}
                    >
                      <Copy className="h-4 w-4" />
                      {t('fileTransfer.ops.copy')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const targets = selectedPaths.includes(contextMenu.item.path) && selectedFiles.length > 1
                          ? selectedFiles.map((item) => item.path)
                          : [contextMenu.item.path];
                        setClipboard({ mode: 'move', paths: targets });
                        setContextMenu(null);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                      disabled={!isLive}
                    >
                      <Scissors className="h-4 w-4" />
                      {t('fileTransfer.ops.cut')}
                    </button>
                    {clipboard && (
                      <button
                        type="button"
                        onClick={() => {
                          setContextMenu(null);
                          void handlePasteClipboard();
                        }}
                        className="app-popover-row text-sm text-accent"
                        disabled={!isLive || opsBusy}
                      >
                        <ClipboardPaste className="h-4 w-4" />
                        {t('fileTransfer.ops.pasteHere', { count: clipboard.paths.length })}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const targets = selectedPaths.includes(contextMenu.item.path) && selectedFiles.length > 1
                          ? selectedFiles.map((item) => item.name)
                          : [contextMenu.item.name];
                        setArchiveModal({
                          names: targets,
                          archiveName: `${targets[0]}.tar.gz`,
                          format: 'tar.gz',
                        });
                        setContextMenu(null);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                      disabled={!isLive}
                    >
                      <Archive className="h-4 w-4" />
                      {t('fileTransfer.ops.compress')}
                    </button>
                    {!contextMenu.item.isDirectory && isExtractableArchive(contextMenu.item.name) && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = contextMenu.item;
                          setContextMenu(null);
                          void handleExtractArchive(target);
                        }}
                        className="app-popover-row text-sm text-fg-secondary"
                        disabled={!isLive || opsBusy}
                      >
                        <FolderArchive className="h-4 w-4" />
                        {t('fileTransfer.ops.extractHere')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setSymlinkModal({
                          targetPath: contextMenu.item.path,
                          linkName: `${contextMenu.item.name}.link`,
                        });
                        setContextMenu(null);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                      disabled={!isLive}
                    >
                      <Link2 className="h-4 w-4" />
                      {t('fileTransfer.ops.createSymlink')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setChownModal({
                          item: contextMenu.item,
                          owner: '',
                          group: '',
                          recursive: false,
                        });
                        setContextMenu(null);
                      }}
                      className="app-popover-row text-sm text-fg-secondary"
                      disabled={!isLive}
                    >
                      <UserCog className="h-4 w-4" />
                      {t('fileTransfer.ops.chown')}
                    </button>
                  </>
                )}
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
                  className="app-popover-row text-sm text-danger dark:text-danger-fg"
                >
                  <Trash2 className="h-4 w-4" />
                  {t('common.delete')}
                </button>
              </div>,
              document.body,
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_56%,var(--bg-secondary))] p-2.5 text-xs text-fg-muted">
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

      {hoverDetail && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-header w-64 rounded-md border border-[color-mix(in_srgb,var(--border-color)_85%,transparent)] bg-[color-mix(in_srgb,var(--bg-secondary)_97%,transparent)] p-2.5 shadow-lg backdrop-blur"
          style={{ left: hoverDetail.x, top: hoverDetail.y }}
        >
          <div className="mb-1.5 flex items-center gap-2">
            <FileTypeIcon
              name={hoverDetail.item.name}
              isDirectory={hoverDetail.item.isDirectory}
              isSymbolicLink={hoverDetail.item.isSymbolicLink}
            />
            <span className="min-w-0 truncate text-xs font-semibold text-fg dark:text-white">
              {hoverDetail.item.name}
            </span>
          </div>
          <dl className="space-y-0.5 text-[11px] leading-5">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-fg-muted">
                {t('fileTransfer.tableHeaders.type')}
              </dt>
              <dd className="min-w-0 flex-1 text-fg-secondary dark:text-fg">
                {hoverDetail.item.isSymbolicLink
                  ? t('fileTransfer.fileTypes.symlink')
                  : hoverDetail.item.isDirectory
                    ? t('fileTransfer.fileTypes.directory')
                    : t('fileTransfer.fileTypes.file')}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-fg-muted">
                {t('fileTransfer.tableHeaders.size')}
              </dt>
              <dd className="tabular-nums text-fg-secondary dark:text-fg">
                {hoverDetail.item.isDirectory ? '—' : formatSize(hoverDetail.item.size)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-fg-muted">
                {t('fileTransfer.tableHeaders.modified')}
              </dt>
              <dd className="tabular-nums text-fg-secondary dark:text-fg">
                {formatTime(hoverDetail.item.mtime)}
              </dd>
            </div>
            {formatPermissions(hoverDetail.item.mode) && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-fg-muted">
                  {t('fileTransfer.detailPermissions')}
                </dt>
                <dd className="font-mono text-fg-secondary dark:text-fg">
                  {formatPermissions(hoverDetail.item.mode)}
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-fg-muted">
                {t('fileTransfer.detailPath')}
              </dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-[10px] text-fg-secondary">
                {hoverDetail.item.path}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {editTarget && (
        <SftpFileEditor
          isOpen
          connectionId={connectionId}
          remotePath={editTarget.path}
          knownSize={editTarget.size}
          onClose={() => setEditTarget(null)}
          onAlert={(message) => {
            setEditTarget(null);
            setEditAlert(message);
          }}
        />
      )}

      {previewTarget && (
        <FilePreviewModal
          connectionId={connectionId}
          file={{ path: previewTarget.path, name: previewTarget.name }}
          onClose={() => setPreviewTarget(null)}
          translate={t}
        />
      )}

      {crossTransferTarget && (
        <CrossServerTransferModal
          isOpen
          sourceConnectionId={connectionId}
          sourceFile={crossTransferTarget}
          onClose={() => setCrossTransferTarget(null)}
          onStarted={(targetServerName) => {
            setBrowserView(connectionId, 'tasks');
            showStatusNotice(t('fileTransfer.crossServer.started', { target: targetServerName }));
          }}
        />
      )}

      <Modal
        isOpen={Boolean(archiveModal)}
        onClose={() => setArchiveModal(null)}
        title={t('fileTransfer.ops.compress')}
        size="sm"
        closeLabel={t('common.close')}
      >
        {archiveModal && (
          <>
            <div className="space-y-3 p-4">
              <div>
                <label className="industrial-field-label">{t('fileTransfer.ops.archiveName')}</label>
                <input
                  type="text"
                  value={archiveModal.archiveName}
                  onChange={(e) => setArchiveModal({ ...archiveModal, archiveName: e.target.value })}
                  className="industrial-input w-full font-mono text-xs"
                />
              </div>
              <div>
                <label className="industrial-field-label">{t('fileTransfer.ops.archiveFormat')}</label>
                <select
                  value={archiveModal.format}
                  onChange={(e) => {
                    const fmt = e.target.value as 'tar.gz' | 'zip';
                    const base = archiveModal.archiveName.replace(/\.(tar\.gz|zip)$/i, '');
                    setArchiveModal({ ...archiveModal, format: fmt, archiveName: `${base}.${fmt}` });
                  }}
                  className="industrial-input w-full text-xs"
                >
                  <option value="tar.gz">tar.gz</option>
                  <option value="zip">zip</option>
                </select>
              </div>
            </div>
            <div className="industrial-modal-footer">
              <button type="button" className="industrial-button-secondary" onClick={() => setArchiveModal(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={opsBusy} className="industrial-button-primary" onClick={() => void handleConfirmArchive()}>
                {t('common.confirm')}
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(symlinkModal)}
        onClose={() => setSymlinkModal(null)}
        title={t('fileTransfer.ops.createSymlink')}
        size="sm"
        closeLabel={t('common.close')}
      >
        {symlinkModal && (
          <>
            <div className="space-y-3 p-4">
              <div>
                <label className="industrial-field-label">{t('fileTransfer.ops.symlinkTarget')}</label>
                <input
                  type="text"
                  value={symlinkModal.targetPath}
                  onChange={(e) => setSymlinkModal({ ...symlinkModal, targetPath: e.target.value })}
                  className="industrial-input w-full font-mono text-xs"
                />
              </div>
              <div>
                <label className="industrial-field-label">{t('fileTransfer.ops.symlinkName')}</label>
                <input
                  type="text"
                  value={symlinkModal.linkName}
                  onChange={(e) => setSymlinkModal({ ...symlinkModal, linkName: e.target.value })}
                  className="industrial-input w-full font-mono text-xs"
                />
              </div>
            </div>
            <div className="industrial-modal-footer">
              <button type="button" className="industrial-button-secondary" onClick={() => setSymlinkModal(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={opsBusy} className="industrial-button-primary" onClick={() => void handleConfirmSymlink()}>
                {t('common.confirm')}
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(chownModal)}
        onClose={() => setChownModal(null)}
        title={t('fileTransfer.ops.chown')}
        size="sm"
        closeLabel={t('common.close')}
      >
        {chownModal && (
          <>
            <div className="space-y-3 p-4">
              <div className="truncate font-mono text-xs text-fg-muted">{chownModal.item.path}</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="industrial-field-label">{t('fileTransfer.ops.owner')}</label>
                  <input
                    type="text"
                    value={chownModal.owner}
                    onChange={(e) => setChownModal({ ...chownModal, owner: e.target.value })}
                    placeholder="root"
                    className="industrial-input w-full font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="industrial-field-label">{t('fileTransfer.ops.group')}</label>
                  <input
                    type="text"
                    value={chownModal.group}
                    onChange={(e) => setChownModal({ ...chownModal, group: e.target.value })}
                    placeholder="www-data"
                    className="industrial-input w-full font-mono text-xs"
                  />
                </div>
              </div>
              {chownModal.item.isDirectory && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-secondary">
                  <input
                    type="checkbox"
                    checked={chownModal.recursive}
                    onChange={(e) => setChownModal({ ...chownModal, recursive: e.target.checked })}
                  />
                  <span>{t('fileTransfer.ops.recursive')}</span>
                </label>
              )}
            </div>
            <div className="industrial-modal-footer">
              <button type="button" className="industrial-button-secondary" onClick={() => setChownModal(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={opsBusy} className="industrial-button-primary" onClick={() => void handleConfirmChown()}>
                {t('common.confirm')}
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(editAlert)}
        onClose={() => setEditAlert(null)}
        title={t('fileTransfer.edit')}
        size="sm"
        closeLabel={t('common.close')}
      >
        <div className="space-y-4 p-4">
          <p className="text-sm leading-6 text-fg-secondary">
            {editAlert}
          </p>
        </div>
        <div className="industrial-modal-footer">
          <button
            type="button"
            className="industrial-button-primary"
            onClick={() => setEditAlert(null)}
          >
            {t('common.confirm')}
          </button>
        </div>
      </Modal>

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
            <label className="block text-sm font-medium text-fg-secondary">
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
              <p className="text-xs text-danger dark:text-danger-fg">{renameError}</p>
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
            <label className="block text-sm font-medium text-fg-secondary">
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
              <p className="text-xs text-danger dark:text-danger-fg">{mkdirError}</p>
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

      <Modal
        isOpen={chmodTarget != null}
        onClose={() => {
          if (!isChmodding) {
            setChmodTarget(null);
            setChmodError(null);
          }
        }}
        title={t('fileTransfer.permissionsTitle')}
        size="sm"
        closeLabel={t('common.close')}
        initialFocusRef={chmodInputRef}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleChmod();
          }}
        >
          <div className="space-y-3 p-4">
            {chmodTarget && (
              <p className="truncate font-mono text-xs text-fg-muted" title={chmodTarget.path}>
                {chmodTarget.path}
              </p>
            )}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-fg-secondary">
                {t('fileTransfer.permissionsLabel')}
              </label>
              <input
                ref={chmodInputRef}
                value={chmodMode}
                onChange={(event) => {
                  setChmodMode(event.target.value);
                  setChmodError(null);
                }}
                className="industrial-input w-full font-mono"
                disabled={isChmodding}
                spellCheck={false}
                autoComplete="off"
                inputMode="numeric"
              />
              <p className="text-xs text-fg-muted">
                {t('fileTransfer.permissionsHint')}
              </p>
            </div>
            {(() => {
              const bits = parseOctalPermissionInput(chmodMode) ?? 0;
              const rows: Array<{ key: string; label: string; shift: number }> = [
                { key: 'owner', label: t('fileTransfer.permissionsOwner'), shift: 6 },
                { key: 'group', label: t('fileTransfer.permissionsGroup'), shift: 3 },
                { key: 'other', label: t('fileTransfer.permissionsOther'), shift: 0 },
              ];
              return (
                <div className="space-y-2 rounded-sm border border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] p-2.5">
                  {rows.map((row) => (
                    <div key={row.key} className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-xs">
                      <span className="text-fg-muted">{row.label}</span>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {([
                          { label: t('fileTransfer.permissionsRead'), mask: 0o4 << row.shift },
                          { label: t('fileTransfer.permissionsWrite'), mask: 0o2 << row.shift },
                          { label: t('fileTransfer.permissionsExec'), mask: 0o1 << row.shift },
                        ] as const).map((bit) => (
                          <label key={bit.mask} className="inline-flex cursor-pointer items-center gap-1 text-fg-secondary">
                            <input
                              type="checkbox"
                              checked={(bits & bit.mask) === bit.mask}
                              onChange={() => toggleChmodBit(bit.mask)}
                              disabled={isChmodding}
                            />
                            {bit.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {chmodError && (
              <p className="text-xs text-danger-fg">{chmodError}</p>
            )}
          </div>
          <div className="industrial-modal-footer">
            <button
              type="button"
              onClick={() => setChmodTarget(null)}
              className="industrial-button-secondary"
              disabled={isChmodding}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="industrial-button-primary"
              disabled={isChmodding}
            >
              {isChmodding ? t('common.loading') : t('common.confirm')}
            </button>
          </div>
        </form>
      </Modal>

      {statusNotice && overlay.isActive && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-8 left-1/2 z-toast -translate-x-1/2 rounded-md border border-line-strong bg-surface-inverse px-3.5 py-1.5 text-xs font-medium text-fg-inverse shadow-lg"
        >
          {statusNotice}
        </div>
      )}

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
    </div>
  );
}
