import { describe, it, expect } from 'vitest';

/**
 * server/index.cjs 的 appendSessionOutput 截断逻辑是内联函数（不导出），
 * 这里的测试是对其语义的镜像验证（与前端 prepareWindowForReplay 同源）：
 * - 超限截断时按行边界对齐；
 * - 截断前处于 alt screen 而窗口内无切换序列 → 注入 \x1b[?1049h 头。
 *
 * 真实 nano 流（WSL nano 7.2 捕获）的关键特征：1049h 只在流头部出现一次，
 * 后续翻页全是 \r\x1b[Nd / \x1b[N;MH 绝对定位重绘（无换行符）。
 */

const ALT_RE = /\x1b\[\?(?:1049|1047|47)([hl])/g;
const ALT_ENTER = '\x1b[?1049h';

function detectAltSwitch(text: string): 'h' | 'l' | null {
  let last: 'h' | 'l' | null = null;
  ALT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ALT_RE.exec(text)) !== null) {
    last = m[1] as 'h' | 'l';
  }
  return last;
}

/** 与 server/index.cjs appendSessionOutput 相同的截断语义。 */
function appendSessionOutputMirror(session: { outputBuffer: string }, text: string, maxBytes: number): void {
  const next = `${session.outputBuffer || ''}${text}`;
  if (next.length <= maxBytes) {
    session.outputBuffer = next;
    return;
  }
  let truncated = next.slice(-maxBytes);
  const lineStart = truncated.search(/[\r\n]/);
  if (lineStart > 0) {
    truncated = truncated.slice(lineStart);
  }
  if (detectAltSwitch(next) === 'h' && detectAltSwitch(truncated) === null) {
    truncated = ALT_ENTER + truncated;
  }
  session.outputBuffer = truncated;
}

/** 构造 mini nano 流：1049h 头 + 30 万字节正文（无换行）。 */
function buildMiniNanoStream(totalBytes: number): string {
  let s = ALT_ENTER;
  s += '\x1b[1;32r\x1b[H\x1b[2J';
  let line = 1;
  while (s.length < totalBytes) {
    s += `\r\x1b[2dLine number ${line} - some content to make it non-trivial`;
    line += 1;
  }
  return s;
}

describe('server appendSessionOutput（alt 状态保持）', () => {
  it('未超限：原样缓冲', () => {
    const session = { outputBuffer: '' };
    appendSessionOutputMirror(session, 'hello\r\n', 1024);
    expect(session.outputBuffer).toBe('hello\r\n');
  });

  it('普通 shell 超限截断：不注入 1049h', () => {
    const session = { outputBuffer: '' };
    const body = 'echo line\r\n'.repeat(60000);
    appendSessionOutputMirror(session, body, 4096);
    expect(session.outputBuffer.length).toBeLessThanOrEqual(4096);
    expect(session.outputBuffer.startsWith(ALT_ENTER)).toBe(false);
  });

  it('nano 场景超限截断：注入 1049h 头，重放后 xterm 停 alt', () => {
    const session = { outputBuffer: '' };
    const stream = buildMiniNanoStream(300000);
    // 分片 append（与真实 pty 分片一致）
    for (let i = 0; i < stream.length; i += 8192) {
      appendSessionOutputMirror(session, stream.slice(i, i + 8192), 65536);
    }
    expect(session.outputBuffer.length).toBeLessThanOrEqual(65536 + ALT_ENTER.length);
    expect(session.outputBuffer.startsWith(ALT_ENTER)).toBe(true);
    expect(detectAltSwitch(session.outputBuffer)).toBe('h');
  });

  it('nano 退出后超限截断（窗口含 1049l）：不注入', () => {
    const session = { outputBuffer: '' };
    const stream = buildMiniNanoStream(300000) + '\x1b[?1049l$ ';
    for (let i = 0; i < stream.length; i += 8192) {
      appendSessionOutputMirror(session, stream.slice(i, i + 8192), 65536);
    }
    expect(detectAltSwitch(session.outputBuffer)).toBe('l');
    expect(session.outputBuffer.startsWith(ALT_ENTER)).toBe(false);
  });
});
