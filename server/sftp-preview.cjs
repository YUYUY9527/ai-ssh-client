'use strict';

const posixPath = require('node:path').posix;

/**
 * 远程文件预览（图片 / PDF）。文本仍走既有在线编辑器，这里补齐二进制可视预览。
 * 经 SFTP 读取整文件（有大小上限），base64 下发，前端用 data URL 渲染，目标机零安装。
 */

const DEFAULT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024; // 10MiB

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

/**
 * 浏览器可内联播放的音视频类型。这类文件**不走 base64 整读**（体积大），
 * 而是走下载路由的 inline 流式模式（支持 Range/边下边播）。
 */
const MEDIA_MIME_BY_EXT = {
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

/** 按扩展名识别可预览的 MIME；不支持返回 null（前端回退到编辑/下载）。 */
function detectPreviewMime(name) {
  const ext = posixPath.extname(String(name || '')).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

function isPreviewable(name) {
  return detectPreviewMime(name) !== null;
}

/** 按扩展名识别音视频 MIME（用于流式内联播放）；不支持返回 null。 */
function detectMediaMime(name) {
  const ext = posixPath.extname(String(name || '')).slice(1).toLowerCase();
  return MEDIA_MIME_BY_EXT[ext] || null;
}

function isMediaPreviewable(name) {
  return detectMediaMime(name) !== null;
}

/** inline 流式预览时使用的 Content-Type：图片/PDF/音视频，其它回落 octet-stream。 */
function resolveInlineMime(name) {
  return detectPreviewMime(name) || detectMediaMime(name) || 'application/octet-stream';
}

/**
 * 读取预览字节。超过上限抛 code='too-large'（附 size），前端提示改用下载。
 * sftp 需提供 stat / createReadStream（ssh2 SFTP 或兼容 mock）。
 */
function readSftpPreview(sftp, remotePath, maxBytes = DEFAULT_PREVIEW_MAX_BYTES) {
  const name = posixPath.basename(String(remotePath || ''));
  const mime = detectPreviewMime(name);

  return new Promise((resolve, reject) => {
    if (!mime) {
      const error = new Error('File type is not previewable');
      error.code = 'not-previewable';
      reject(error);
      return;
    }

    sftp.stat(remotePath, (statError, stats) => {
      if (statError) {
        reject(statError);
        return;
      }
      const size = Number(stats?.size || 0);
      if (size > maxBytes) {
        const error = new Error(`File is too large to preview (${size} bytes)`);
        error.code = 'too-large';
        error.size = size;
        reject(error);
        return;
      }

      const chunks = [];
      let received = 0;
      const stream = sftp.createReadStream(remotePath);
      stream.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          const error = new Error(`File is too large to preview (${received} bytes)`);
          error.code = 'too-large';
          error.size = received;
          try { stream.destroy(); } catch { /* ignore */ }
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        resolve({
          name,
          mime,
          size: received,
          base64: Buffer.concat(chunks).toString('base64'),
        });
      });
    });
  });
}

module.exports = {
  detectPreviewMime,
  isPreviewable,
  detectMediaMime,
  isMediaPreviewable,
  resolveInlineMime,
  readSftpPreview,
  DEFAULT_PREVIEW_MAX_BYTES,
  MIME_BY_EXT,
  MEDIA_MIME_BY_EXT,
};