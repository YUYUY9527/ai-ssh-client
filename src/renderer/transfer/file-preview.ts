/**
 * 远程文件预览的纯前端判定（镜像 server/sftp-preview.cjs 的 detectPreviewMime）。
 * 仅用于决定 UI 是否展示「预览」入口；真正能否预览以服务端返回为准。
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
};

export function detectPreviewMime(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? null;
}

export function isPreviewable(name: string): boolean {
  return detectPreviewMime(name) !== null;
}

/**
 * 浏览器可内联播放的音视频类型（镜像 server/sftp-preview.cjs 的 MEDIA_MIME_BY_EXT）。
 * 这类文件不走 base64，而走下载路由 inline 流式模式（支持大文件与拖动进度）。
 */
const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};

export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | null;

export function detectMediaMime(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return MEDIA_MIME_BY_EXTENSION[ext] ?? null;
}

export function isMediaPreviewable(name: string): boolean {
  return detectMediaMime(name) !== null;
}

/** 归类预览类型：图片/PDF 走 base64，音视频走流式，其余 null（回退编辑/下载）。 */
export function previewKind(name: string): PreviewKind {
  const baseMime = detectPreviewMime(name);
  if (baseMime === 'application/pdf') return 'pdf';
  if (baseMime && baseMime.startsWith('image/')) return 'image';
  const mediaMime = detectMediaMime(name);
  if (mediaMime?.startsWith('video/')) return 'video';
  if (mediaMime?.startsWith('audio/')) return 'audio';
  return null;
}

/** 由 base64 预览数据构造可嵌入 <img>/<iframe> 的 data URI。 */
export function previewDataUri(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}