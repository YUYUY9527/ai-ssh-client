// @vitest-environment jsdom
/**
 * 回归测试：nano 编辑超长文本时内容显示不全、下方编辑指引消失。
 *
 * 数据背景（用 WSL Ubuntu nano 7.2 真实 PTY 捕获流的结构特征构造）：
 * - nano 进入 alt screen 只发一次 \x1b[?1049h（在流最头部），此后翻页/重绘
 *   全部用 \r\x1b[Nd（VPA）/ \x1b[N;MH（CUP）在既有行上绝对定位重绘，
 *   流中不含 LF/CRLF 行边界；
 * - 标题栏（行 1）、状态栏（行 30）、帮助栏（行 31/32）只在打开瞬间绘制
 *   一次，翻页增量只重画文本区（行 2..29）。
 *
 * 原缺陷链：
 * 1) store/server 输出缓冲超限截断 → 唯一的 1049h 被滑掉；
 * 2) 截断窗口直接重放 → xterm 停在 normal buffer，nano 的定位重绘全部
 *    错位（行号粘连、内容不全）；
 * 3) 帮助栏/标题栏在截断窗口里根本没有 → 即使换行对了也画不出来；
 * 4) 旧校准 planReplayCalibration 只认 chunk 尾部 1049 → 永不触发。
 *
 * 修复：
 * 1) 截断时按 alt 状态在窗口头部注入 \x1b[?1049h（prepareWindowForReplay）；
 * 2) 校准升级：chunk 尾部为进入 alt、或 chunk 无切换但重放前 xterm 已在
 *    alt → 补 1049h + 向 PTY 发 Ctrl+L（\x0c），nano 全屏重绘会重建
 *    标题/状态栏/帮助栏（真实捕获已证实）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  ALT_ENTER_SEQUENCE,
  prepareWindowForReplay,
  scanAltScreenState,
} from '../src/renderer/session/terminal/terminal-alt';
import { planReplayCalibration } from '../src/renderer/session/terminal/terminal-replay';

beforeAll(() => {
  const ctx: Record<string, unknown> = new Proxy({}, {
    get: () => () => ({}),
    set: () => true,
  });
  (window as any).HTMLCanvasElement.prototype.getContext = () => ctx;
  (window as any).HTMLCanvasElement.prototype.toDataURL = () => '';
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });
  (window as any).matchMedia = (query: string) => ({
    matches: false, media: query,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  });
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 480, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 1200, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 480, configurable: true });
});

const ROWS = 32;
const STORE_LIMIT = 150 * 1024;

function flush(term: Terminal): Promise<void> {
  return new Promise((resolve) => { term.write('', resolve); });
}

function makeTerminal(): Terminal {
  const term = new Terminal({ rows: ROWS, cols: 120, scrollback: 3000, allowProposedApi: true });
  const container = document.createElement('div');
  container.style.width = '1200px';
  container.style.height = '480px';
  document.body.appendChild(container);
  term.open(container);
  return term;
}

function screenLine(term: Terminal, y: number): string {
  const line = term.buffer.active.getLine(y);
  if (!line) return '';
  let text = '';
  for (let x = 0; x < 120; x++) text += line.getCell(x)?.getChars() ?? ' ';
  return text.replace(/\s+$/, '');
}

function screenText(term: Terminal): string {
  return Array.from({ length: term.buffer.active.length }, (_, y) => screenLine(term, y)).join('\n');
}

function contentLine(n: number): string {
  return `Line number ${n} - some content to make it non-trivial`;
}

/**
 * 构造 nano 风格的完整会话流（与真实 PTY 捕获结构一致）：
 * 打开 30000 行文件 + 连续翻页，无退出。
 */
function buildNanoSession(pageCount: number, firstLine = 1): string {
  let s = '';
  s += '$ nano bigfile.txt\r\n';
  s += ALT_ENTER_SEQUENCE;                       // 进入 alt（唯一一次，流最前）
  s += '\x1b[22;0;0t\x1b[1;32r\x1b[m\x1b[4l\x1b[?7h\x1b[39;49m\x1b[?1h\x1b=\x1b[?25l\x1b[H\x1b[2J';
  s += `\x1b[1;1H\x1b[0;7m  GNU nano 7.2                                        /tmp/bigfile.txt`;
  // 文本区 28 行（行 2..29），用 CUP 定位
  for (let i = 0; i < 28; i++) {
    s += `\x1b[${i + 2};1H${contentLine(firstLine + i)}`;
  }
  // 状态栏（行 30）+ 帮助栏（行 31/32）——只在打开时绘制
  s += `\x1b[30;1H\x1b[0;7m[ Read 30000 lines ]\x1b[0m`;
  s += `\r\x1b[31d\x1b[0;7m^G\x1b[0m Help\x1b[0;7m^O\x1b[0m Write Out`;
  s += `\r\x1b[32d\x1b[0;7m^X\x1b[0m Exit\x1b[0;7m^R\x1b[0m Read File`;
  // 翻页：行 2..29 绝对定位重绘（无 LF，与真实 nano 一致）
  let line = firstLine + 28;
  for (let page = 0; page < pageCount; page++) {
    for (let i = 0; i < 28; i++) {
      s += `\x1b[${i + 2};1H${contentLine(line + i)}`;
    }
    line += 28;
  }
  return s;
}

/** nano 对 Ctrl+L 的全屏重绘响应（与真实捕获一致：2J + 重画 31 行含帮助栏）。 */
function nanoFullRedraw(firstLine: number): string {
  let s = '\x1b[2J';
  s += `\x1b[1;1H\x1b[0;7m  GNU nano 7.2                                        /tmp/bigfile.txt`;
  for (let i = 0; i < 28; i++) {
    s += `\x1b[${i + 2};1H${contentLine(firstLine + i)}`;
  }
  s += `\x1b[30;1H\x1b[0;7m[ Read 30000 lines ]\x1b[0m`;
  s += `\r\x1b[31d\x1b[0;7m^G\x1b[0m Help\x1b[0;7m^O\x1b[0m Write Out`;
  s += `\r\x1b[32d\x1b[0;7m^X\x1b[0m Exit\x1b[0;7m^R\x1b[0m Read File`;
  return s;
}

describe('nano 长文本编辑（bug 回归）', () => {
  it('构造流特征与真实 nano 一致：1049h 只在头部、active 段无 LF、帮助栏只在打开时绘制', () => {
    const s = buildNanoSession(600);
    expect(s.startsWith('$ nano bigfile.txt\r\n\x1b[?1049h')).toBe(true);
    expect(s.length).toBeGreaterThan(STORE_LIMIT);
    // nano 进入 alt 后的编辑流不使用 LF 行边界（真实 PTY 捕获：LF count = 0）
    const active = s.slice(s.indexOf('\x1b[?1049h'));
    expect(active.includes('\n')).toBe(false);
  });

  it('旧缺陷复现：截断窗口（无 1049h、无标题/帮助栏）直接重放 → 停 normal buffer、内容错位', async () => {
    const s = buildNanoSession(600);
    // 模拟修复前的截断（纯 slice + 行边界）
    let truncated = s.slice(-STORE_LIMIT);
    const lineStart = truncated.search(/[\r\n]/);
    if (lineStart > 0) truncated = truncated.slice(lineStart);
    expect(truncated).not.toContain('\x1b[?1049h');

    const term = makeTerminal();
    term.reset();
    term.write(truncated);
    await flush(term);
    // 坏状态：normal buffer
    expect(term.buffer.active.type).toBe('normal');
    const text = screenText(term);
    // 帮助栏（打开时绘制）丢失
    expect(text).not.toContain('^G');
    expect(text).not.toContain('GNU nano');
    term.dispose();
  });

  it('修复1：截断窗口注入 1049h 头 → 重放后 xterm 停在 alt buffer，文本区完整', async () => {
    const s = buildNanoSession(600);
    const windowed = prepareWindowForReplay(s, STORE_LIMIT);
    expect(windowed.startsWith('\x1b[?1049h')).toBe(true);
    expect(scanAltScreenState(windowed)).toBe(true);

    const term = makeTerminal();
    term.reset();
    term.write(windowed);
    await flush(term);
    expect(term.buffer.active.type).toBe('alternate');
    // 文本区可读（行不与相邻行粘连成 2xxxxx3xxxx 样式的错乱）
    const text = screenText(term);
    const lines = text.split('\n').filter((l) => l.includes('Line number'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(/^Line number \d+ - some content/);
    }
    term.dispose();
  });

  it('修复2：校准升级——chunk 无切换 + 重放前在 alt → 补 1049h + 触发 Ctrl+L 重绘', async () => {
    const s = buildNanoSession(600);
    const windowed = prepareWindowForReplay(s, STORE_LIMIT);
    expect(detectLastAltSwitchForTest(windowed)).toBe('h'); // 注入头在窗口内

    // "旧数据"等价场景：窗口本身无切换（未注入的历史快照），但重放前
    // xterm 已在 alt → 应补写 1049h 并触发 redraw
    const rawWindow = windowed.slice(ALT_ENTER_SEQUENCE.length);
    expect(detectLastAltSwitchForTest(rawWindow)).toBeNull();
    const plan = planReplayCalibration(rawWindow, false, true);
    expect(plan.write).toBe('\x1b[?1049h');
    expect(plan.redraw).toBe(true);

    // 新数据（注入头在窗口内）→ chunk 尾部为进入 → redraw，xterm 已在 alt 则不补写
    const plan2 = planReplayCalibration(windowed, true, false);
    expect(plan2.write).toBe('');
    expect(plan2.redraw).toBe(true);
  });

  it('修复端到端：注入头 + 校准 Ctrl+L → nano 重绘后标题/文本/帮助栏全部恢复', async () => {
    const s = buildNanoSession(600);
    const windowed = prepareWindowForReplay(s, STORE_LIMIT);

    const term = makeTerminal();
    // 生产 replay：reset + 写窗口（窗口自带注入头）
    term.reset();
    const wasInAlt = term.buffer.active.type === 'alternate'; // 刷新场景 = false
    term.write(windowed);
    await flush(term);
    expect(term.buffer.active.type).toBe('alternate');

    // 校准（生产同参数）
    const calibration = planReplayCalibration(
      windowed,
      term.buffer.active.type === 'alternate',
      wasInAlt,
    );
    expect(calibration.redraw).toBe(true);

    // 模拟 nano 收到 Ctrl+L 后的全屏重绘输出（经 WS 回流 store→xterm）
    term.write(nanoFullRedraw(16801));
    await flush(term);

    const text = screenText(term);
    expect(term.buffer.active.type).toBe('alternate');
    expect(text).toContain('GNU nano 7.2');
    expect(text).toContain('Line number 16801');
    expect(text).toContain('[ Read 30000 lines ]');
    expect(text).toContain('^G');
    expect(text).toContain('Help');
    expect(text).toContain('^X');
    expect(text).toContain('Exit');
    term.dispose();
  });
});

function detectLastAltSwitchForTest(content: string): 'h' | 'l' | null {
  let last: 'h' | 'l' | null = null;
  const re = /\x1b\[\?(?:1049|1047|47)([hl])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    last = m[1] as 'h' | 'l';
  }
  return last;
}
