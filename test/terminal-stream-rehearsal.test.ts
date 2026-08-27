// @vitest-environment jsdom
/**
 * 流式链路路演测试:模拟 server appendSessionOutput → client boundSessionOutput
 * → planTerminalOutputSync → xterm 写入,观察最终画面,验证 nano 行号粘连修复。
 *
 * 覆盖的场景（真实链路结构,与修复前失败的截图症状一一对应）：
 * - 路演1：完整流 → server 截断（含注入头）→ client 同宽装载 → replay → 画面
 * - 路演2：流式分批（WS 帧大小）→ store 持续截断窗口化 → append/replay → 画面
 * - 路演3：xterm 逐帧直达（无 store 截断）→ 验证 xterm 自身跨帧续接能力
 * - 单元：deltaAfterBoundedSlideDetailed 滑动路径的 kept/delta 语义
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { prepareWindowForReplay } from '../src/renderer/session/terminal/terminal-alt';
import {
  deltaAfterBoundedSlideDetailed,
  planTerminalOutputSync,
} from '../src/renderer/session/terminal/terminal-output-sync';

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
const LIMIT = 150 * 1024;

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
  return `${String(n).padStart(4, ' ')}  Line number ${n} - some content to make it non-trivial`;
}

/** nano 风格完整会话流（与真实 PTY 捕获结构一致，翻页用 CUP 绝对定位，无 LF）。 */
function buildNanoSession(pageCount: number, firstLine = 1): string {
  let s = '';
  s += '$ nano bigfile.txt\r\n';
  s += '\x1b[?1049h';
  s += '\x1b[1;32r\x1b[m\x1b[4l\x1b[?7h\x1b[39;49m\x1b[?1h\x1b=\x1b[?25l\x1b[H\x1b[2J';
  s += `\x1b[1;1H\x1b[0;7m  GNU nano 7.2                                        /tmp/bigfile.txt`;
  for (let i = 0; i < 28; i++) {
    s += `\x1b[${i + 2};1H${contentLine(firstLine + i)}`;
  }
  s += `\x1b[30;1H\x1b[0;7m[ Read 30000 lines ]\x1b[0m`;
  s += `\x1b[31;1H\x1b[0;7m^G\x1b[0m Help\x1b[0;7m^O\x1b[0m Write Out`;
  s += `\x1b[32;1H\x1b[0;7m^X\x1b[0m Exit\x1b[0;7m^R\x1b[0m Read File`;
  let line = firstLine + 28;
  for (let page = 0; page < pageCount; page++) {
    for (let i = 0; i < 28; i++) {
      s += `\x1b[${i + 2};1H${contentLine(line + i)}`;
    }
    line += 28;
  }
  return s;
}

/** 检查屏幕文本中的 CUP 序列残片（行号粘连症状：`[N;MH` 被当文本绘制）。 */
function cueResidueLines(text: string): string[] {
  return text.split('\n').filter((l) => /[0-9]+;[0-9]+H/.test(l));
}

describe('nano 流式链路路演', () => {
  it('路演1:完整流→server截断(含注头)→client同宽装载→replay→画面检查', async () => {
    const full = buildNanoSession(600);
    expect(full.length).toBeGreaterThan(LIMIT);

    // 真实 server 逻辑（appendSessionOutput）：截断 + 按 alt 状态注入 1049h 头
    const serverWindow = prepareWindowForReplay(full, LIMIT);
    expect(serverWindow.startsWith('\x1b[?1049h')).toBe(true);

    // client 侧以同宽上限装载（serverWindow 剥离头后恰好等于 LIMIT，不再截断）
    const clientWindow = prepareWindowForReplay(serverWindow, LIMIT);

    const term = makeTerminal();
    term.reset();
    const plan = planTerminalOutputSync('', clientWindow);
    expect(plan.action).toBe('replay');
    term.write(plan.chunk);
    await flush(term);

    const text = screenText(term);
    // 截断窗口头部会滑落标题/帮助栏（固有局限；实时会话由 Ctrl+L 校准重绘）。
    // 此用例只验证：buffer 停在 alt + 行号/内容不粘连 + 内容完整。
    expect(term.buffer.active.type).toBe('alternate');
    expect(text).toContain('Line number 16822');
    expect(cueResidueLines(text).length).toBe(0);
    term.dispose();
  });

  it('路演1b:server截断实时追加(每2KB)到client store→replay 校验最终画面', async () => {
    const full = buildNanoSession(600);

    // 模拟 server: 持续 append + 截断(每 2KB),产出 serverWindow 序列
    let serverStore = '';
    let serverWindow = '';
    const serverWindows: string[] = [];
    for (let off = 0; off < full.length; off += 2048) {
      serverStore += full.slice(off, off + 2048);
      serverWindow = serverStore.length > LIMIT
        ? prepareWindowForReplay(serverStore, LIMIT)
        : serverStore;
      serverWindows.push(serverWindow);
    }
    // 模拟 client: store 每接收 serverWindow 就可能触发截断,再 replay 到 xterm
    const term = makeTerminal();
    term.reset();
    let rendered = '';
    for (const w of serverWindows) {
      const clientWindow = prepareWindowForReplay(w, LIMIT);
      const plan = planTerminalOutputSync(rendered, clientWindow);
      if (plan.action === 'append') {
        term.write(plan.chunk);
        rendered = clientWindow;
      } else if (plan.action === 'replay') {
        term.reset();
        term.write(plan.chunk);
        rendered = clientWindow;
      }
    }
    await flush(term);
    const text = screenText(term);

    // 实时链路 + 校准重绘后:标题/行号完整、无粘连
    expect(term.buffer.active.type).toBe('alternate');
    expect(text).toContain('GNU nano');
    expect(text).toContain('^G');
    expect(text).toContain('Line number 16822');
    expect(cueResidueLines(text).length).toBe(0);
    term.dispose();
  });

  it('路演2:翻页增量 append 路径画面检查（截断持续发生）', { timeout: 20000 }, async () => {
    const full = buildNanoSession(600);

    // 模拟 store:分批 appendOutput(截断窗口化)+ planTerminalOutputSync → xterm
    const term = makeTerminal();
    term.reset();

    let rendered = '';
    let store = '';
    // 按 4KB/块 逐块写（模拟 WS 实时流）,超过 LIMIT 后走窗口化
    for (let off = 0; off < full.length; off += 4096) {
      store += full.slice(off, off + 4096);
      const windowed = prepareWindowForReplay(store, LIMIT);
      const plan = planTerminalOutputSync(rendered, windowed);
      if (plan.action === 'append') {
        term.write(plan.chunk);
        rendered = windowed;
      } else if (plan.action === 'replay') {
        term.reset();
        term.write(plan.chunk);
        rendered = windowed;
      }
      if (off === 0 || off === 151552 || off >= 153600) {
        await flush(term);
      }
    }
    await flush(term);
    const text = screenText(term);

    expect(term.buffer.active.type).toBe('alternate');
    expect(text).toContain('GNU nano');
    expect(text).toContain('^G');
    expect(text).toContain('Line number 16827');
    expect(cueResidueLines(text).length).toBe(0);
    term.dispose();
  });

  it('路演3:xterm 逐帧写入(WS帧大小)直接验证裸片段续接', async () => {
    // 不经过 store 截断/对齐：模拟 WS 帧以 4096 字节直达 xterm，
    // 验证 xterm 自身的跨帧续接能力（\x1b[5 + ;1H... 应拼成完整 CSI）
    const full = buildNanoSession(600);
    const term = makeTerminal();
    term.reset();
    for (let off = 0; off < full.length; off += 4096) {
      term.write(full.slice(off, off + 4096));
    }
    await flush(term);
    const text = screenText(term);
    expect(cueResidueLines(text).length).toBe(0);
    expect(text).toContain('GNU nano');
    expect(text).toContain('^G');
    term.dispose();
  });

  it('单元:deltaAfterBoundedSlideDetailed 滑动路径返回 kept 与 delta', () => {
    // prev 尾以 \x1b[5 悬挂、curr 以 ;1H... 续接 → startsWith 分支，
    // kept=prev 全长（悬挂 ESC 保留），delta 为裸续接字节
    const prev = 'ABC \x1b[5';
    const curr = 'ABC \x1b[5;1HX';
    const r = deltaAfterBoundedSlideDetailed(prev, curr);
    expect(r).not.toBeNull();
    expect(r!.kept).toBe(prev.length);
    expect(r!.delta).toBe(';1HX');
  });
});
