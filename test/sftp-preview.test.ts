import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  detectPreviewMime,
  isPreviewable,
  readSftpPreview,
  detectMediaMime,
  isMediaPreviewable,
  resolveInlineMime,
} from '../server/sftp-preview.cjs';

function mockSftp(content: Buffer, sizeOverride?: number) {
  return {
    stat(_path: string, cb: (error: null, stats: { size: number }) => void) {
      cb(null, { size: sizeOverride ?? content.length });
    },
    createReadStream() {
      return Readable.from([content]);
    },
  };
}

describe('远程文件预览', () => {
  it('按扩展名识别图片/PDF，其它返回 null', () => {
    expect(detectPreviewMime('a.png')).toBe('image/png');
    expect(detectPreviewMime('a.JPG')).toBe('image/jpeg');
    expect(detectPreviewMime('a.svg')).toBe('image/svg+xml');
    expect(detectPreviewMime('doc.pdf')).toBe('application/pdf');
    expect(detectPreviewMime('note.txt')).toBeNull();
    expect(detectPreviewMime('archive.zip')).toBeNull();
    expect(isPreviewable('x.webp')).toBe(true);
    expect(isPreviewable('x.bin')).toBe(false);
  });

  it('读取小文件返回 base64 与 mime', async () => {
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await readSftpPreview(mockSftp(content) as never, '/root/a.png');
    expect(result.mime).toBe('image/png');
    expect(result.name).toBe('a.png');
    expect(result.size).toBe(4);
    expect(result.base64).toBe(content.toString('base64'));
  });

  it('不可预览类型抛 not-previewable', async () => {
    await expect(readSftpPreview(mockSftp(Buffer.from('x')) as never, '/root/a.txt'))
      .rejects.toMatchObject({ code: 'not-previewable' });
  });

  it('超过上限抛 too-large 并附 size', async () => {
    const content = Buffer.alloc(2048);
    await expect(readSftpPreview(mockSftp(content) as never, '/root/big.png', 1024))
      .rejects.toMatchObject({ code: 'too-large' });
  });

  it('stat 报的大小超限则直接拒绝（不读取）', async () => {
    const content = Buffer.alloc(10);
    await expect(readSftpPreview(mockSftp(content, 999999) as never, '/root/big.pdf', 1024))
      .rejects.toMatchObject({ code: 'too-large', size: 999999 });
  });

  it('音视频按扩展名识别为可流式预览的 mime', () => {
    expect(detectMediaMime('movie.mp4')).toBe('video/mp4');
    expect(detectMediaMime('clip.M4V')).toBe('video/mp4');
    expect(detectMediaMime('a.webm')).toBe('video/webm');
    expect(detectMediaMime('song.mp3')).toBe('audio/mpeg');
    expect(detectMediaMime('voice.m4a')).toBe('audio/mp4');
    expect(detectMediaMime('x.flac')).toBe('audio/flac');
    expect(detectMediaMime('note.txt')).toBeNull();
    expect(isMediaPreviewable('v.ogv')).toBe(true);
    expect(isMediaPreviewable('v.mkv')).toBe(false);
  });

  it('resolveInlineMime 优先图片/PDF，其次音视频，否则 octet-stream', () => {
    expect(resolveInlineMime('a.png')).toBe('image/png');
    expect(resolveInlineMime('a.pdf')).toBe('application/pdf');
    expect(resolveInlineMime('a.mp4')).toBe('video/mp4');
    expect(resolveInlineMime('a.mp3')).toBe('audio/mpeg');
    expect(resolveInlineMime('a.zip')).toBe('application/octet-stream');
    expect(resolveInlineMime('noext')).toBe('application/octet-stream');
  });

  it('音视频不进 base64 预览路径（readSftpPreview 仍拒绝）', async () => {
    await expect(readSftpPreview(mockSftp(Buffer.from('x')) as never, '/root/a.mp4'))
      .rejects.toMatchObject({ code: 'not-previewable' });
  });
});