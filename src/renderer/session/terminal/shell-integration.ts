/** 超链接识别与 Shell Integration OSC 解析（纯函数，可单测）。 */

const HTTP_URL_RE = /https?:\/\/[^\s<>"'`\])},;]+/gi;

/** 从文本中提取 HTTP(S) URL（去掉常见尾随标点）。 */
export function detectHttpUrls(text: string): string[] {
  if (!text) {
    return [];
  }

  const found: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  HTTP_URL_RE.lastIndex = 0;

  while ((match = HTTP_URL_RE.exec(text)) !== null) {
    let url = match[0];
    // 去掉常见尾随标点
    url = url.replace(/[.,;:!?)]+$/g, '');
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    found.push(url);
  }

  return found;
}

/** 判断字符串是否为可打开的 HTTP(S) 链接。 */
export function isOpenableHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ShellIntegrationState {
  cwd: string | null;
  /** 最近一次识别到的命令边界：start / end / null */
  lastMarker: 'A' | 'B' | 'C' | 'D' | null;
  commandRunning: boolean;
  lastExitCode: number | null;
}

/** 创建初始 Shell Integration 状态。 */
export function createShellIntegrationState(): ShellIntegrationState {
  return {
    cwd: null,
    lastMarker: null,
    commandRunning: false,
    lastExitCode: null,
  };
}

/** 从 OSC 7 file:// URI 中解析路径。 */
export function parseOsc7Cwd(payload: string): string | null {
  const body = payload.replace(/^7;/, '');
  if (!body) {
    return null;
  }

  // file://hostname/path 或 file:///path
  if (body.startsWith('file://')) {
    try {
      const url = new URL(body);
      let path = decodeURIComponent(url.pathname || '');
      // Windows 风格 file:///C:/... 保留；Unix file://host/tmp → /tmp
      if (path.length > 1 && /^\/[A-Za-z]:\//.test(path)) {
        path = path.slice(1);
      }
      return path || null;
    } catch {
      // 宽松回退：取第三个 / 之后
      const match = body.match(/^file:\/\/[^/]*(.*)$/);
      if (match?.[1]) {
        try {
          return decodeURIComponent(match[1]) || null;
        } catch {
          return match[1] || null;
        }
      }
      return null;
    }
  }

  // 某些 shell 直接发路径
  if (body.startsWith('/')) {
    try {
      return decodeURIComponent(body);
    } catch {
      return body;
    }
  }

  return null;
}

/** 解析 OSC 133 标记载荷（A/B/C/D[;exit]）。 */
export function parseOsc133Marker(payload: string): {
  marker: 'A' | 'B' | 'C' | 'D' | null;
  exitCode: number | null;
} {
  const body = payload.replace(/^133;/, '');
  if (!body) {
    return { marker: null, exitCode: null };
  }

  const markerChar = body.charAt(0).toUpperCase();
  if (markerChar !== 'A' && markerChar !== 'B' && markerChar !== 'C' && markerChar !== 'D') {
    return { marker: null, exitCode: null };
  }

  let exitCode: number | null = null;
  if (markerChar === 'D') {
    const parts = body.split(';');
    if (parts.length > 1 && parts[1] !== '') {
      const code = Number.parseInt(parts[1], 10);
      if (Number.isFinite(code)) {
        exitCode = code;
      }
    }
  }

  return { marker: markerChar, exitCode };
}

/**
 * 将一条完整 OSC 载荷应用到状态（payload 形如 `7;file://...` 或 `133;A`）。
 * 非法输入不抛错，原样返回 prev。
 */
export function applyOscPayload(
  prev: ShellIntegrationState,
  payload: string,
): ShellIntegrationState {
  if (!payload || typeof payload !== 'string') {
    return prev;
  }

  try {
    if (payload.startsWith('7;') || payload === '7') {
      const cwd = parseOsc7Cwd(payload);
      if (cwd) {
        return { ...prev, cwd };
      }
      return prev;
    }

    if (payload.startsWith('133;') || payload === '133') {
      const { marker, exitCode } = parseOsc133Marker(payload);
      if (!marker) {
        return prev;
      }

      const next: ShellIntegrationState = {
        ...prev,
        lastMarker: marker,
      };

      if (marker === 'B' || marker === 'C') {
        next.commandRunning = true;
      }
      if (marker === 'A') {
        next.commandRunning = false;
      }
      if (marker === 'D') {
        next.commandRunning = false;
        if (exitCode !== null) {
          next.lastExitCode = exitCode;
        }
      }

      return next;
    }
  } catch {
    return prev;
  }

  return prev;
}

const OSC_COMPLETE_RE = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * 从一段输出文本中提取完整 OSC 序列并更新 Shell Integration 状态。
 * 残缺序列忽略（不抛错）。
 */
export function consumeShellIntegrationChunk(
  prev: ShellIntegrationState,
  chunk: string,
): ShellIntegrationState {
  if (!chunk) {
    return prev;
  }

  let next = prev;
  OSC_COMPLETE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OSC_COMPLETE_RE.exec(chunk)) !== null) {
    next = applyOscPayload(next, match[1] || '');
  }

  return next;
}

/** 可跨 chunk 缓冲的 Shell Integration 解析器。 */
export class ShellIntegrationParser {
  private pending = '';
  private state: ShellIntegrationState = createShellIntegrationState();

  /** 当前集成状态。 */
  getState(): ShellIntegrationState {
    return this.state;
  }

  /** 重置状态与缓冲。 */
  reset(): void {
    this.pending = '';
    this.state = createShellIntegrationState();
  }

  /**
   * 喂入远端输出分片；返回更新后的状态。
   * 不修改原始输出（调用方仍应把 chunk 写给 xterm）。
   */
  feed(chunk: string): ShellIntegrationState {
    if (!chunk) {
      return this.state;
    }

    const text = this.pending + chunk;
    this.pending = '';

    // 保留可能跨 chunk 的 OSC 前缀
    const lastEsc = text.lastIndexOf('\x1b]');
    let processable = text;
    if (lastEsc >= 0) {
      const tail = text.slice(lastEsc);
      const closed = /\x07|\x1b\\/.test(tail);
      if (!closed) {
        this.pending = tail;
        processable = text.slice(0, lastEsc);
      }
    }

    this.state = consumeShellIntegrationChunk(this.state, processable);
    return this.state;
  }
}
