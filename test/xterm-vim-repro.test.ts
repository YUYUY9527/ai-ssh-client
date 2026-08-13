// @vitest-environment jsdom
/**
 * 复现并验证 vim 大文件滚动丢内容 + 右侧滚动条问题。
 *
 * 根因链：
 *  1) store/server 输出缓冲超限截断 → 重放 chunk 丢失 \x1b[?1049h（进入
 *     alt screen 序列）→ xterm 停在 normal buffer → 滚动条出现 + vim 画面错位；
 *  2) 旧实现 replay 用 term.clear()：vim 感知不到屏幕被清，增量输出画在
 *     残画面上 → 上方内容缺失。
 *
 * 修复：
 *  - 缓冲按行边界截断（appendSessionOutput / boundSessionOutput）
 *  - replay 用 term.reset() 干净重建
 *  - 重放后按 chunk 尾部的 alt 状态校准（补 1049h + Ctrl+L 让 vim 重绘）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { detectChunkEndsInAltScreen, planReplayCalibration } from '../src/renderer/session/terminal/terminal-replay';

// ---- jsdom 环境补齐：canvas mock + 尺寸 ----
beforeAll(() => {
  const ctx: Record<string, unknown> = new Proxy({}, {
    get: () => () => ({}),
    set: () => true,
  });
  (window as any).HTMLCanvasElement.prototype.getContext = () => ctx;
  (window as any).HTMLCanvasElement.prototype.toDataURL = () => '';
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  });
  (window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom 无真实布局/渲染：不执行 rAF 回调，避免 xterm 渲染器初始化崩溃。
  // 测试只关心 buffer 状态机（type / length / 内容），不依赖渲染。
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 480, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 480, configurable: true });
});

const ROWS = 24;
const COLS = 80;

function flush(term: Terminal): Promise<void> {
  return new Promise((resolve) => {
    term.write('', resolve);
  });
}

function makeTerminal(): Terminal {
  const term = new Terminal({ rows: ROWS, cols: COLS, scrollback: 3000, allowProposedApi: true });
  const container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '480px';
  document.body.appendChild(container);
  term.open(container);
  return term;
}

function screenText(term: Terminal): string {
  const lines: string[] = [];
  const buf = term.buffer.active;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (line) {
      let text = '';
      for (let x = 0; x < COLS; x++) {
        text += line.getCell(x)?.getChars() ?? ' ';
      }
      lines.push(text.replace(/\s+$/, ''));
    }
  }
  return lines.join('\n');
}

/** 模拟 vim 打开大文件：进 alt screen + 绘制 ROWS 行屏幕。 */
async function openVim(term: Terminal, firstLine = 1): Promise<void> {
  term.write('\x1b[?1049h'); // alt screen
  await flush(term);
  term.write('\x1b[2J'); // 清屏
  for (let i = 0; i < ROWS; i++) {
    term.write(`\x1b[${i + 1};1Hline-${firstLine + i}`);
  }
  await flush(term);
}

/**
 * 模拟 vim 向下翻页（真实做法）：scroll region 全屏 → 光标到底部 →
 * 连续 LF 滚动 N 行 → CUP 定位重画底部 N 行。
 */
async function vimScrollDown(term: Terminal, startLine: number, count = 12): Promise<void> {
  term.write('\x1b[1;24r'); // 全屏 scroll region
  term.write('\x1b[24;1H'); // 光标到末行
  term.write('\n'.repeat(count)); // 滚动 count 行（底部留空）
  await flush(term);
  for (let i = 0; i < count; i++) {
    term.write(`\x1b[${ROWS - count + 1 + i};1Hline-${startLine + i}`);
  }
  term.write('\x1b[1;24r'); // 恢复全屏 region
  await flush(term);
}

/** 生成一段"完整 vim 会话"输出：shell 历史 + 进入 alt + vim 屏幕。 */
function buildVimSessionChunk(firstLine = 1): string {
  let chunk = '$ vim bigfile\r\n';
  chunk += '\x1b[?1049h'; // 进入 alt screen
  chunk += '\x1b[2J';
  for (let i = 0; i < ROWS; i++) {
    chunk += `\x1b[${i + 1};1Hline-${firstLine + i}`;
  }
  return chunk;
}

describe('detectChunkEndsInAltScreen / planReplayCalibration', () => {
  it('空 chunk / 无 alt 序列 → 不校准', () => {
    expect(detectChunkEndsInAltScreen('')).toBe(false);
    expect(detectChunkEndsInAltScreen('$ echo hi\r\nhi\r\n$ ')).toBe(false);
    expect(planReplayCalibration('$ echo hi\r\n', false)).toEqual({ write: '', redraw: false });
  });

  it('chunk 以进入 alt 结尾 → 需要校准', () => {
    const chunk = buildVimSessionChunk();
    expect(detectChunkEndsInAltScreen(chunk)).toBe(true);
    expect(planReplayCalibration(chunk, false)).toEqual({ write: '\x1b[?1049h', redraw: true });
    expect(planReplayCalibration(chunk, true)).toEqual({ write: '', redraw: true });
  });

  it('最后一次切换是退出 alt → 不校准', () => {
    const chunk = buildVimSessionChunk() + '\r\n\x1b[?1049l';
    expect(detectChunkEndsInAltScreen(chunk)).toBe(false);
    expect(planReplayCalibration(chunk, false)).toEqual({ write: '', redraw: false });
  });
});

describe('vim 大文件滚动（xterm 5.5.0 实测）', () => {
  it('基线：vim 正常打开，alt buffer length === rows，无滚动条', async () => {
    const term = makeTerminal();
    await openVim(term, 1);
    expect(term.buffer.active.type).toBe('alternate');
    expect(term.buffer.active.length).toBe(ROWS);
    const text = screenText(term);
    expect(text).toContain('line-1');
    expect(text).toContain(`line-${ROWS}`);
    term.dispose();
  });

  it('vim 向下翻页（真实序列：先滚动再定位画内容）内容完整', async () => {
    const term = makeTerminal();
    await openVim(term, 1);
    await vimScrollDown(term, ROWS + 1, 12);
    // 屏幕应显示 line-13 .. line-36（24 行），无缺失
    const text = screenText(term);
    expect(text).toContain('line-13');
    expect(text).toContain('line-36');
    // 行数未超视口：无滚动条（length === rows）
    expect(term.buffer.active.length).toBe(ROWS);
    term.dispose();
  });

  it('完整 chunk 重放（term.reset + 写入）后 vim 画面完整', async () => {
    const term = makeTerminal();
    await openVim(term, 1);
    // 模拟 replay：reset + 重放完整历史
    term.reset();
    term.write(buildVimSessionChunk());
    await flush(term);
    expect(term.buffer.active.type).toBe('alternate');
    expect(term.buffer.active.length).toBe(ROWS);
    const text = screenText(term);
    expect(text).toContain('line-1');
    expect(text).toContain(`line-${ROWS}`);
    term.dispose();
  });

  it('截断 chunk 重放缺 1049h：xterm 停在 normal buffer（滚动条出现）→ 校准补写后恢复', async () => {
    const term = makeTerminal();
    const fullChunk = buildVimSessionChunk(1);
    // 模拟行边界截断：从 "vim 屏幕中间" 开始（丢 1049h 和屏幕上半部）
    const truncationPoint = fullChunk.indexOf('line-10');
    const truncatedChunk = fullChunk.slice(truncationPoint);
    expect(truncatedChunk.includes('\x1b[?1049h')).toBe(false);

    // 重放截断 chunk：xterm 停在 normal buffer；vim 后续增量输出（LF）
    // 使 normal buffer 行数增长 → scrollArea 高于视口 → 滚动条
    term.reset();
    term.write(truncatedChunk);
    await flush(term);
    expect(term.buffer.active.type).toBe('normal');
    term.write('\x1b[1;24r\x1b[24;1H\n\n\n'); // vim 增量滚动继续
    await flush(term);
    expect(term.buffer.active.length).toBeGreaterThan(ROWS);

    // 校准：真实输出流以 1049h 结尾 → 补写 1049h 恢复 alt screen
    const plan = planReplayCalibration(fullChunk, false);
    expect(plan.write).toBe('\x1b[?1049h');
    expect(plan.redraw).toBe(true);
    term.write(plan.write);
    await flush(term);
    expect(term.buffer.active.type).toBe('alternate');
    expect(term.buffer.active.length).toBe(ROWS);
    term.dispose();
  });

  it('截断重放后 vim 增量滚动仍缺画面上方 → 发 Ctrl+L 重绘后恢复（修复验证）', async () => {
    const term = makeTerminal();
    // vim 打开中发生重放：reset + 写入截断 chunk（只含屏幕后半部分）
    term.reset();
    const fullChunk = buildVimSessionChunk(1);
    const truncatedChunk = fullChunk.slice(fullChunk.indexOf('line-13'));
    term.write(truncatedChunk);
    await flush(term);

    // 校准：xterm 不在 alt → 补 1049h；随后发 Ctrl+L（\x0c）让 vim 全屏重绘
    const plan = planReplayCalibration(fullChunk, term.buffer.active.type === 'alternate');
    if (plan.write) {
      term.write(plan.write);
      await flush(term);
    }
    // 模拟 vim 收到 Ctrl+L 后的全屏重绘
    term.write('\x1b[2J');
    for (let i = 0; i < ROWS; i++) {
      term.write(`\x1b[${i + 1};1Hline-${1 + i}`);
    }
    await flush(term);
    expect(term.buffer.active.type).toBe('alternate');
    const text = screenText(term);
    expect(text).toContain('line-1');
    expect(text).toContain(`line-${ROWS}`);
    expect(term.buffer.active.length).toBe(ROWS);
    term.dispose();
  });

  it('普通 shell 输出重放（无 alt 序列）不触发校准', async () => {
    const term = makeTerminal();
    term.reset();
    term.write('$ echo hello\r\nhello\r\n$ ');
    await flush(term);
    expect(term.buffer.active.type).toBe('normal');
    const plan = planReplayCalibration('$ echo hello\r\nhello\r\n$ ', false);
    expect(plan).toEqual({ write: '', redraw: false });
    term.dispose();
  });
});
