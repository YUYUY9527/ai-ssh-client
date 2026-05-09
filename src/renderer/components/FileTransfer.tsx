import { useState, useEffect, useRef } from 'react';
import {
  X,
  Folder,
  File,
  FileText,
  Image,
  Archive,
  Upload,
  Download,
  Home,
  ChevronRight,
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle,
  Trash2,
} from 'lucide-react';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  fileType: string;
}

interface TransferTask {
  id: string;
  name: string;
  type: 'upload' | 'download';
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'error';
  error?: string;
}

interface FileTransferProps {
  connectionId: string;
  onClose: () => void;
}

export function FileTransfer({ connectionId, onClose }: FileTransferProps) {
  const [currentPath, setCurrentPath] = useState('/home');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [transferTasks, setTransferTasks] = useState<TransferTask[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 监听上传进度
  useEffect(() => {
    if (!window.electronAPI?.onSftpUploadProgress) return;

    const cleanup = window.electronAPI.onSftpUploadProgress((data) => {
      setTransferTasks(prev =>
        prev.map(t =>
          t.name === data.filename && t.type === 'upload' && t.status === 'transferring'
            ? { ...t, progress: data.progress }
            : t
        )
      );
    });

    return cleanup;
  }, []);

  // 加载目录文件
  const loadDirectory = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.listDirectory(connectionId, path);
        if (result.success && result.data) {
          setFiles(result.data.files);
          setCurrentPath(path);
        } else {
          setError(result.error || '加载目录失败');
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDirectory(currentPath);
  }, [connectionId, currentPath]);

  // 获取文件图标
  const getFileIcon = (file: FileItem) => {
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

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / k ** i).toFixed(1)) + ' ' + sizes[i];
  };

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const pad = (value: number) => value.toString().padStart(2, '0');

    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  // 获取文件类型
  const getFileType = (file: FileItem): string => {
    if (file.isDirectory) return '目录';
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (['', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) return '图片';
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) return '压缩包';
    if (['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'conf', 'log', 'ini', 'cfg'].includes(ext)) return '文本';
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh'].includes(ext)) return '代码';
    if (['html', 'css', 'scss', 'sass', 'less'].includes(ext)) return 'Web';
    if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(ext)) return '音频';
    if (['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'].includes(ext)) return '视频';
    if (['pdf'].includes(ext)) return 'PDF';
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'Office';
    if (ext) return ext.toUpperCase() + ' 文件';
    return '文件';
  };

  // 导航到路径
  const navigateTo = (path: string) => {
    loadDirectory(path);
  };

  // 返回上级目录
  const goUp = () => {
    const parts = currentPath.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts.pop();
      const newPath = '/' + parts.join('/');
      navigateTo(newPath || '/');
    }
  };

  // 导航到家目录
  const goHome = () => {
    navigateTo('/home');
  };

  // 下载文件
  const handleDownload = async (file: FileItem) => {
    const task: TransferTask = {
      id: Date.now().toString(),
      name: file.name,
      type: 'download',
      progress: 0,
      status: 'pending',
    };

    setTransferTasks(prev => [...prev, task]);

    try {
      setTransferTasks(prev =>
        prev.map(t => (t.id === task.id ? { ...t, status: 'transferring' } : t))
      );

      if (window.electronAPI) {
        const result = await window.electronAPI.downloadFile(connectionId, file.path);
        if (result.success) {
          setTransferTasks(prev =>
            prev.map(t => (t.id === task.id ? { ...t, status: 'completed', progress: 100 } : t))
          );
        } else {
          setTransferTasks(prev =>
            prev.map(t => (t.id === task.id ? { ...t, status: 'error', error: result.error } : t))
          );
        }
      }
    } catch (err) {
      setTransferTasks(prev =>
        prev.map(t => (t.id === task.id ? { ...t, status: 'error', error: (err as Error).message } : t))
      );
    }
  };

  // 上传文件
  const handleUpload = async (localPath?: string) => {
    let selectedPath = localPath;

    // 如果没有提供本地路径，使用 selectFile 选择文件
    if (!selectedPath && window.electronAPI) {
      const result = await window.electronAPI.selectFile({
        title: '选择要上传的文件',
        properties: ['openFile'],
      });
      if (!result.success || result.data?.canceled || !result.data?.filePath) {
        return;
      }
      selectedPath = result.data.filePath;
    }

    if (!selectedPath) {
      return;
    }

    const filename = selectedPath.split(/[/\\]/).pop() || 'unknown';
    const task: TransferTask = {
      id: Date.now().toString(),
      name: filename,
      type: 'upload',
      progress: 0,
      status: 'pending',
    };

    setTransferTasks(prev => [...prev, task]);

    try {
      setTransferTasks(prev =>
        prev.map(t => (t.id === task.id ? { ...t, status: 'transferring' } : t))
      );

      if (window.electronAPI) {
        const result = await window.electronAPI.uploadFile(connectionId, selectedPath, currentPath);
        if (result.success) {
          setTransferTasks(prev =>
            prev.map(t => (t.id === task.id ? { ...t, status: 'completed', progress: 100 } : t))
          );
          loadDirectory(currentPath);
        } else if (result.error !== 'Cancelled') {
          setTransferTasks(prev =>
            prev.map(t => (t.id === task.id ? { ...t, status: 'error', error: result.error } : t))
          );
        }
      }
    } catch (err) {
      setTransferTasks(prev =>
        prev.map(t => (t.id === task.id ? { ...t, status: 'error', error: (err as Error).message } : t))
      );
    }
  };

  // 拖拽上传 - 当用户拖拽文件时，自动弹出文件选择对话框
  // 因为在 Electron 的 contextIsolation 模式下，无法直接获取拖拽文件的路径
  useEffect(() => {
    const dropZone = dropZoneRef.current;
    if (!dropZone) return;

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
      // 只有完全离开 dropZone 时才取消高亮
      if (!dropZone.contains(e.relatedTarget as Node)) {
        setIsDragOver(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      // 在 contextIsolation 模式下，无法直接获取拖拽文件的路径
      // 所以弹出文件选择对话框，让用户选择要上传的文件
      console.log('检测到文件拖拽，打开文件选择对话框');
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
  }, [currentPath, connectionId]);

  // 删除传输记录
  const removeTask = (taskId: string) => {
    setTransferTasks(prev => prev.filter(t => t.id !== taskId));
  };

  // 路径导航面包屑
  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="industrial-modal w-full max-w-4xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="industrial-modal-header">
          <h2 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Folder className="w-5 h-5 text-teal-500" />
            文件传输 - SFTP
          </h2>
          <button
            onClick={onClose}
            className="icon-button"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="p-3 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] flex items-center gap-2 bg-[color-mix(in_srgb,var(--bg-primary)_48%,var(--bg-secondary))]">
          <button
            onClick={goHome}
            className="icon-button"
            title="家目录"
          >
            <Home className="w-4 h-4" />
          </button>
          <button
            onClick={goUp}
            className="icon-button"
            title="上级目录"
          >
            <ChevronRight className="w-4 h-4 rotate-180" />
          </button>
          <button
            onClick={() => loadDirectory(currentPath)}
            className="icon-button"
            title="刷新"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {/* 路径输入框 */}
          <input
            type="text"
            value={currentPath}
            onChange={(e) => setCurrentPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                loadDirectory(currentPath);
              }
            }}
            className="industrial-input flex-1 py-1"
            placeholder="输入路径后按回车跳转..."
          />
          <div className="flex-1" />
          <button
            onClick={() => handleUpload()}
            className="industrial-button-primary px-3 py-1.5"
          >
            <Upload className="w-4 h-4" />
            上传
          </button>
        </div>

        {/* Path Breadcrumb */}
        <div className="px-3 py-2 border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_66%,var(--bg-secondary))] flex items-center gap-1 text-sm overflow-x-auto">
          <button
            onClick={() => navigateTo('/')}
            className="text-slate-500 hover:text-teal-500 whitespace-nowrap"
          >
            /
          </button>
          {pathParts.map((part, index) => (
            <span key={index} className="flex items-center">
              <ChevronRight className="w-3 h-3 text-slate-400 mx-0.5" />
              <button
                onClick={() => navigateTo('/' + pathParts.slice(0, index + 1).join('/'))}
                className="text-slate-500 hover:text-teal-500 whitespace-nowrap"
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex">
          {/* File List */}
          <div
            ref={dropZoneRef}
            className={`file-transfer-scroll relative flex-1 overflow-y-auto p-2 ${isDragOver ? 'bg-teal-50 dark:bg-teal-900/20 ring-2 ring-teal-500 ring-inset' : ''}`}
          >
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-full text-red-500">
                <AlertCircle className="w-5 h-5 mr-2" />
                {error}
              </div>
            ) : files.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-400">
                <Folder className="w-12 h-12 mb-2 opacity-50" />
                <p className="text-sm">空目录</p>
                <p className="text-xs mt-1">拖拽文件到此处将自动弹出选择对话框</p>
              </div>
            ) : (
              <div className="space-y-1">
                {/* Header */}
                <div className="industrial-table-head grid grid-cols-[minmax(0,4.4fr)_minmax(0,2fr)_minmax(5.5rem,1.2fr)_minmax(11.5rem,1.8fr)_2rem] gap-3">
                  <div>名称</div>
                  <div>类型</div>
                  <div className="text-right">大小</div>
                  <div className="text-right">修改时间</div>
                  <div />
                </div>
                {files.map((file, index) => (
                  <div
                    key={index}
                    onClick={() => file.isDirectory ? navigateTo(file.path) : setSelectedFile(file)}
                    onDoubleClick={() => file.isDirectory && navigateTo(file.path)}
                    className="grid grid-cols-[minmax(0,4.4fr)_minmax(0,2fr)_minmax(5.5rem,1.2fr)_minmax(11.5rem,1.8fr)_2rem] gap-3 px-3 py-2 hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)] rounded-sm cursor-pointer transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {getFileIcon(file)}
                      <span className="truncate text-sm text-slate-900 dark:text-white">{file.name}</span>
                    </div>
                    <div className="flex items-center min-w-0 text-sm text-slate-500 dark:text-slate-400">
                      {getFileType(file)}
                    </div>
                    <div className="text-right text-sm text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums">
                      {file.isDirectory ? '-' : formatSize(file.size)}
                    </div>
                    <div className="text-right text-sm text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums">
                      {formatTime(file.mtime)}
                    </div>
                    <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      {!file.isDirectory && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownload(file);
                          }}
                          className="icon-button h-7 w-7 text-teal-500"
                          title="下载"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 flex items-center justify-center bg-teal-500/20 border-2 border-dashed border-teal-500 rounded-sm pointer-events-none">
                <div className="text-teal-500 font-medium">释放后将弹出文件选择对话框</div>
              </div>
            )}
          </div>

          {/* Transfer Tasks Sidebar */}
          {transferTasks.length > 0 && (
            <div className="file-transfer-scroll w-64 border-l border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] overflow-y-auto bg-[color-mix(in_srgb,var(--bg-primary)_54%,var(--bg-secondary))]">
              <div className="p-3 border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)]">
                <h3 className="text-sm font-medium text-slate-900 dark:text-white">传输任务</h3>
              </div>
              <div className="p-2 space-y-2">
                {transferTasks.map(task => (
                  <div key={task.id} className="industrial-card p-2">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {task.type === 'upload' ? (
                          <Upload className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
                        ) : (
                          <Download className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                        )}
                        <span className="text-xs text-slate-700 dark:text-slate-300 truncate">
                          {task.name}
                        </span>
                      </div>
                      <button
                        onClick={() => removeTask(task.id)}
                        className="icon-button h-6 w-6"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      {task.status === 'transferring' && (
                        <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-sm overflow-hidden">
                          <div
                            className="h-full bg-teal-500 rounded-sm transition-all"
                            style={{ width: `${task.progress}%` }}
                          />
                        </div>
                      )}
                      {task.status === 'completed' && (
                        <CheckCircle className="w-4 h-4 text-green-500" />
                      )}
                      {task.status === 'error' && (
                        <AlertCircle className="w-4 h-4 text-red-500" title={task.error} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between bg-[color-mix(in_srgb,var(--bg-primary)_56%,var(--bg-secondary))]">
          <span>{files.length} 个项目</span>
          <span>SFTP 传输</span>
        </div>
      </div>
    </div>
  );
}
