import { useCallback, useEffect, useRef, useState } from 'react';
import { FileAudio, FileImage, FileVideo, RefreshCw } from 'lucide-react';
import { Modal } from '../shared-ui/Modal';
import type { SftpPreviewResult } from '../../shared/ipc-types';
import { previewDataUri, previewKind } from './file-preview';

interface FilePreviewModalProps {
  connectionId: string;
  file: { path: string; name: string };
  onClose: () => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * 远程文件预览弹窗，按类型分流：
 * - 图片 / PDF：服务端 readSftpPreview 整读（≤10MiB）以 base64 返回，data URI 内联渲染；
 * - 音视频：走下载路由的 inline 流式 URL（Range 边下边播），大文件也不占内存、可拖动进度；
 * - 其它：提示无法内联预览，请下载。
 */
export function FilePreviewModal({ connectionId, file, onClose, translate }: FilePreviewModalProps) {
  const kind = previewKind(file.name);
  const mediaUrl =
    kind === 'video' || kind === 'audio'
      ? window.electronAPI?.getSftpMediaPreviewUrl?.(connectionId, file.path) ?? null
      : null;
  const isStreaming = mediaUrl !== null;
  const isBase64 = kind === 'image' || kind === 'pdf';
  const unsupported = !isStreaming && !isBase64;

  const [preview, setPreview] = useState<SftpPreviewResult | null>(null);
  const [loading, setLoading] = useState(isBase64);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const api = window.electronAPI?.previewSftpFile;
    if (!api) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api(connectionId, file.path);
      if (seq !== requestSeq.current) return;
      if (result.success && result.data) {
        setPreview(result.data);
      } else {
        setPreview(null);
        setError(result.success ? translate('features.preview.failed') : (result.error || translate('features.preview.failed')));
      }
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setPreview(null);
      setError(err instanceof Error ? err.message : translate('features.preview.failed'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [connectionId, file.path, translate]);

  useEffect(() => {
    if (isBase64) {
      void load();
    }
    return () => { requestSeq.current += 1; };
  }, [load, isBase64]);

  const dataUri = preview ? previewDataUri(preview.mime, preview.base64) : null;
  const isPdf = preview?.mime === 'application/pdf';

  const titleIcon =
    kind === 'video' ? <FileVideo className="w-4 h-4 shrink-0 text-accent" />
      : kind === 'audio' ? <FileAudio className="w-4 h-4 shrink-0 text-accent" />
        : <FileImage className="w-4 h-4 shrink-0 text-accent" />;

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="3xl"
      title={
        <span className="flex items-center gap-2 truncate">
          {titleIcon}
          <span className="truncate">{file.name}</span>
        </span>
      }
      closeLabel={translate('common.close')}
    >
      <div className="p-4">
        {isStreaming && (
          <div className="flex items-center justify-center bg-surface rounded-lg p-2 min-h-[200px]">
            {kind === 'video' ? (
              <video
                src={mediaUrl ?? undefined}
                controls
                preload="metadata"
                className="max-w-full max-h-[70vh] rounded bg-black"
                onError={() => setError(translate('features.preview.unsupported'))}
              />
            ) : (
              <audio
                src={mediaUrl ?? undefined}
                controls
                preload="metadata"
                className="w-full"
                onError={() => setError(translate('features.preview.unsupported'))}
              />
            )}
          </div>
        )}
        {isStreaming && error && (
          <p className="mt-3 text-sm text-danger dark:text-danger-fg text-center">{error}</p>
        )}

        {!isStreaming && loading && (
          <div className="flex items-center justify-center py-16 text-sm text-fg-subtle">
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            {translate('features.preview.loading')}
          </div>
        )}

        {!isStreaming && !loading && error && (
          <div className="py-10 text-center space-y-3">
            <p className="text-sm text-danger dark:text-danger-fg">{error}</p>
            <button
              type="button"
              onClick={() => { void load(); }}
              className="text-sm text-accent dark:text-accent-hover hover:underline inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {translate('features.preview.retry')}
            </button>
          </div>
        )}

        {!isStreaming && !loading && !error && dataUri && (
          <div className="flex items-center justify-center bg-surface rounded-lg p-2 min-h-[200px]">
            {isPdf ? (
              <iframe
                src={dataUri}
                title={file.name}
                className="w-full h-[70vh] rounded bg-white"
              />
            ) : (
              <img
                src={dataUri}
                alt={file.name}
                className="max-w-full max-h-[70vh] object-contain"
              />
            )}
          </div>
        )}

        {unsupported && !error && (
          <div className="py-16 text-center text-sm text-fg-muted">
            {translate('features.preview.unsupported')}
          </div>
        )}

        {preview && (
          <p className="mt-3 text-xs text-fg-subtle text-right tabular-nums">
            {formatBytes(preview.size)}
          </p>
        )}
      </div>
    </Modal>
  );
}
