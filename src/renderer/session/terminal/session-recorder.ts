/**
 * 终端会话录像器与解析器（asciinema v2 `.cast` NDJSON 格式）。
 * 格式规范：
 * - 第一行 JSON 头：{ "version": 2, "width": 120, "height": 32, "timestamp": 1700000000, "title": "..." }
 * - 后续每行一个事件：[elapsedSeconds, "o", dataString]
 */

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  title?: string;
}

export type CastEvent = [number, 'o' | 'i', string];

export interface ParsedCastRecording {
  header: CastHeader;
  events: CastEvent[];
  durationSec: number;
}

export interface CastRecorder {
  recordOutput: (data: string) => void;
  getEventCount: () => number;
  getDurationSec: () => number;
  exportCast: () => string;
}

export function createCastRecorder(options: { width?: number; height?: number; title?: string } = {}): CastRecorder {
  const startedAtMs = Date.now();
  const header: CastHeader = {
    version: 2,
    width: Math.max(20, Math.floor(options.width || 120)),
    height: Math.max(5, Math.floor(options.height || 32)),
    timestamp: Math.floor(startedAtMs / 1000),
    ...(options.title ? { title: options.title } : {}),
  };
  const events: CastEvent[] = [];

  return {
    recordOutput(data: string) {
      if (!data) return;
      const elapsed = Math.max(0, Number(((Date.now() - startedAtMs) / 1000).toFixed(4)));
      events.push([elapsed, 'o', data]);
    },
    getEventCount() {
      return events.length;
    },
    getDurationSec() {
      return events.length > 0 ? events[events.length - 1][0] : (Date.now() - startedAtMs) / 1000;
    },
    exportCast() {
      const lines = [
        JSON.stringify(header),
        ...events.map((ev) => JSON.stringify(ev)),
      ];
      return `${lines.join('\n')}\n`;
    },
  };
}

/** 解析 asciinema v2 `.cast` 文件内容。 */
export function parseCastFile(rawText: string): ParsedCastRecording {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error('Empty .cast file');
  }
  const parsedHeader = JSON.parse(lines[0]) as Partial<CastHeader>;
  if (parsedHeader.version !== 2) {
    throw new Error('Only asciinema v2 (.cast) format is supported');
  }
  const header: CastHeader = {
    version: 2,
    width: Math.max(20, Number(parsedHeader.width) || 120),
    height: Math.max(5, Number(parsedHeader.height) || 32),
    timestamp: Number(parsedHeader.timestamp) || Math.floor(Date.now() / 1000),
    title: typeof parsedHeader.title === 'string' ? parsedHeader.title : undefined,
  };
  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    try {
      const row = JSON.parse(lines[i]) as unknown;
      if (Array.isArray(row) && row.length >= 3 && typeof row[0] === 'number' && typeof row[2] === 'string') {
        const type = row[1] === 'i' ? 'i' : 'o';
        events.push([Math.max(0, row[0]), type, row[2]]);
      }
    } catch {
      // 忽略损坏行
    }
  }
  events.sort((a, b) => a[0] - b[0]);
  const durationSec = events.length > 0 ? events[events.length - 1][0] : 0;
  return { header, events, durationSec };
}

export function triggerCastDownload(castContent: string, filename: string): void {
  const blob = new Blob([castContent], { type: 'application/x-asciicast;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.cast') ? filename : `${filename}.cast`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
