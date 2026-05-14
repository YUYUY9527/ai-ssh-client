import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { Search, ZoomIn, ZoomOut, Copy, Clipboard, Terminal as TerminalIcon, Edit3 } from 'lucide-react';
import { useConnectionStore } from '../store/useConnectionStore';
import { useTheme } from '../hooks/useTheme';
import { t } from '../i18n';
import type { CommandHistoryItem, AppSettings } from '../../shared/types';

const XTERM_SCROLLBACK_LINES = 10000;
const MIN_TERMINAL_FONT_SIZE = 10;
const MAX_TERMINAL_FONT_SIZE = 24;
const DEFAULT_TERMINAL_FONT_FAMILY = "Consolas, 'Courier New', monospace";

function clampTerminalFontSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 14;
  }

  return Math.min(Math.max(Math.round(value ?? 14), MIN_TERMINAL_FONT_SIZE), MAX_TERMINAL_FONT_SIZE);
}

function getTerminalFontFamily(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized || DEFAULT_TERMINAL_FONT_FAMILY;
}

// 右键菜单组件
function ContextMenu({
  x,
  y,
  onCopy,
  onPaste,
  onPasteToInput,
  onPasteToAI,
  onClose,
}: {
  x: number;
  y: number;
  onCopy: () => void;
  onPaste: () => void;
  onPasteToInput: () => void;
  onPasteToAI: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    if (!menuRef.current) return;

    const menuRect = menuRef.current.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let newX = x;
    let newY = y;

    // 检查是否超出右边界
    if (x + menuRect.width > windowWidth) {
      newX = windowWidth - menuRect.width - 8; // 留 8px 边距
    }

    // 检查是否超出下边界
    if (y + menuRect.height > windowHeight) {
      newY = windowHeight - menuRect.height - 8; // 留 8px 边距
    }

    // 确保不会超出左边界和上边界
    newX = Math.max(8, newX);
    newY = Math.max(8, newY);

    setPosition({ x: newX, y: newY });
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="app-popover fixed top-auto mt-0 py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onCopy(); }}
        className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
      >
        <Copy className="w-4 h-4" />
        复制
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onPaste(); }}
        className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
      >
        <Clipboard className="w-4 h-4" />
        粘贴
      </button>
      <div className="border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] my-1" />
      <button
        onClick={(e) => { e.stopPropagation(); onPasteToInput(); }}
        className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
      >
        <Edit3 className="w-4 h-4" />
        粘贴到终端输入栏
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onPasteToAI(); }}
        className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
      >
        <Edit3 className="w-4 h-4" />
        粘贴到AI助手
      </button>
    </div>
  );
}

interface TerminalProps {
  connectionId: string | null;
  onCommandRequest?: (command: string) => void;
  onPasteToAI?: (text: string) => void;
  theme?: 'dark' | 'light' | 'system';
  settings?: AppSettings;
}


// 终端主题配置 - 扩展多个预设
export const TERMINAL_THEMES: Record<string, any> = {
  dark: {
    background: '#060b10',
    foreground: '#e7ece7',
    cursor: '#14b8a6',
    selectionBackground: '#0d3b38',
    black: '#0c1319',
    red: '#f87171',
    green: '#34d399',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#f472b6',
    cyan: '#2dd4bf',
    white: '#cdd6cf',
    brightBlack: '#5e6b69',
    brightRed: '#fca5a5',
    brightGreen: '#6ee7b7',
    brightYellow: '#fcd34d',
    brightBlue: '#93c5fd',
    brightMagenta: '#f9a8d4',
    brightCyan: '#5eead4',
    brightWhite: '#f5f7f2',
  },
  light: {
    background: '#f6f2e8',
    foreground: '#1f2a27',
    cursor: '#0f766e',
    selectionBackground: '#bfe3de',
    black: '#1f2a27',
    red: '#dc2626',
    green: '#0f766e',
    yellow: '#b45309',
    blue: '#1d4ed8',
    magenta: '#be185d',
    cyan: '#0f766e',
    white: '#d9d2c3',
    brightBlack: '#6b776f',
    brightRed: '#ef4444',
    brightGreen: '#14b8a6',
    brightYellow: '#d97706',
    brightBlue: '#2563eb',
    brightMagenta: '#db2777',
    brightCyan: '#14b8a6',
    brightWhite: '#111827',
  },
  // 额外主题
  monokai: {
    background: '#272822',
    foreground: '#F8F8F2',
    cursor: '#F8F8F0',
    selectionBackground: '#49483E',
    black: '#272822',
    red: '#F92672',
    green: '#A6E22E',
    yellow: '#F4BF75',
    blue: '#66D9EF',
    magenta: '#AE81FF',
    cyan: '#A1EFE4',
    white: '#F8F8F2',
    brightBlack: '#75715E',
    brightRed: '#F92672',
    brightGreen: '#A6E22E',
    brightYellow: '#F4BF75',
    brightBlue: '#66D9EF',
    brightMagenta: '#AE81FF',
    brightCyan: '#A1EFE4',
    brightWhite: '#F9F8F5',
  },
  solarized: {
    background: '#002B36',
    foreground: '#839496',
    cursor: '#839496',
    selectionBackground: '#073642',
    black: '#002B36',
    red: '#DC322F',
    green: '#859900',
    yellow: '#B58900',
    blue: '#268BD2',
    magenta: '#D33682',
    cyan: '#2AA198',
    white: '#EEE8D5',
    brightBlack: '#002B36',
    brightRed: '#CB4B16',
    brightGreen: '#859900',
    brightYellow: '#B58900',
    brightBlue: '#268BD2',
    brightMagenta: '#D33682',
    brightCyan: '#2AA198',
    brightWhite: '#FDF6E3',
  },
  oneDark: {
    background: '#282C34',
    foreground: '#ABB2BF',
    cursor: '#528BFF',
    selectionBackground: '#3E4451',
    black: '#282C34',
    red: '#E06C75',
    green: '#98C379',
    yellow: '#E5C07B',
    blue: '#61AFEF',
    magenta: '#C678DD',
    cyan: '#56B6C2',
    white: '#ABB2BF',
    brightBlack: '#5C6370',
    brightRed: '#E06C75',
    brightGreen: '#98C379',
    brightYellow: '#E5C07B',
    brightBlue: '#61AFEF',
    brightMagenta: '#C678DD',
    brightCyan: '#56B6C2',
    brightWhite: '#FFFFFF',
  },
  nord: {
    background: '#2E3440',
    foreground: '#D8DEE9',
    cursor: '#D8DEE9',
    selectionBackground: '#434C5E',
    black: '#3B4252',
    red: '#BF616A',
    green: '#A3BE8C',
    yellow: '#EBCB8B',
    blue: '#81A1C1',
    magenta: '#B48EAD',
    cyan: '#88C0D0',
    white: '#E5E9F0',
    brightBlack: '#4C566A',
    brightRed: '#BF616A',
    brightGreen: '#A3BE8C',
    brightYellow: '#EBCB8B',
    brightBlue: '#81A1C1',
    brightMagenta: '#B48EAD',
    brightCyan: '#8FBCBB',
    brightWhite: '#ECEFF4',
  },
  dracula: {
    background: '#282A36',
    foreground: '#F8F8F2',
    cursor: '#F8F8F0',
    selectionBackground: '#44475A',
    black: '#282A36',
    red: '#FF5555',
    green: '#50FA7B',
    yellow: '#F1FA8C',
    blue: '#BD93F9',
    magenta: '#FF79C6',
    cyan: '#8BE9FD',
    white: '#F8F8F2',
    brightBlack: '#6272A4',
    brightRed: '#FF6E6E',
    brightGreen: '#69FF94',
    brightYellow: '#FFFFA5',
    brightBlue: '#D6ACFF',
    brightMagenta: '#FF92DF',
    brightCyan: '#A4FFFF',
    brightWhite: '#FFFFFF',
  },
  github: {
    background: '#24292E',
    foreground: '#D1D5DA',
    cursor: '#C8C8C8',
    selectionBackground: '#3392FF44',
    black: '#24292E',
    red: '#F97583',
    green: '#85E89D',
    yellow: '#FFEA7F',
    blue: '#79B8FF',
    magenta: '#B392F0',
    cyan: '#79B8FF',
    white: '#D1D5DA',
    brightBlack: '#636E7B',
    brightRed: '#F97583',
    brightGreen: '#85E89D',
    brightYellow: '#FFEA7F',
    brightBlue: '#79B8FF',
    brightMagenta: '#B392F0',
    brightCyan: '#79B8FF',
    brightWhite: '#FAFBFC',
  },
  ubuntu: {
    background: '#300A24',
    foreground: '#FFFFFF',
    cursor: '#EEEEEC',
    selectionBackground: '#B5D5FF',
    black: '#2E3436',
    red: '#CC0000',
    green: '#4E9A06',
    yellow: '#C4A000',
    blue: '#3465A4',
    magenta: '#75507B',
    cyan: '#06989A',
    white: '#D3D7CF',
    brightBlack: '#555753',
    brightRed: '#EF2929',
    brightGreen: '#8AE234',
    brightYellow: '#FCE94F',
    brightBlue: '#729FCF',
    brightMagenta: '#AD7FA8',
    brightCyan: '#34E2E2',
    brightWhite: '#EEEEEC',
  },
};

// 主题名称映射
const THEME_NAMES: Record<string, string> = {
  dark: '默认暗色',
  light: '默认亮色',
  monokai: 'Monokai',
  solarized: 'Solarized Dark',
  oneDark: 'One Dark',
  nord: 'Nord',
  dracula: 'Dracula',
  github: 'GitHub Dark',
  ubuntu: 'Ubuntu',
};

// 获取当前实际使用的主题（处理 system 主题）
const getEffectiveTheme = (theme: 'dark' | 'light' | 'system'): 'dark' | 'light' => {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
};

export function Terminal({ connectionId, onCommandRequest, onPasteToAI, theme: themeProp, settings }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fontSize, setFontSize] = useState(() => clampTerminalFontSize(settings?.fontSize));
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState(settings?.terminalTheme || 'dark');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const initTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fitTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isAlternateScreenRef = useRef(false);
  const currentInputRef = useRef('');
  const cwdRef = useRef('~'); // 跟踪当前工作目录
  const sshDataCleanupRef = useRef<(() => void) | null>(null);
  
  // 如果没有传入 theme，则使用 useTheme hook
  const { theme: hookTheme } = useTheme();
  const theme = themeProp ?? hookTheme;

  const [commandHistory, setCommandHistory] = useState<CommandHistoryItem[]>([]);

  // 直接调用 SSH resize API，不依赖 store 的 activeConnectionId
  const resizeSSH = useCallback((cols: number, rows: number) => {
    if (connectionId && window.electronAPI) {
      window.electronAPI.sshResize(connectionId, cols, rows);
    }
  }, [connectionId]);

  const syncAlternateScreenState = useCallback(() => {
    const isAlternateScreen = xtermRef.current?.buffer.active.type === 'alternate';
    if (isAlternateScreenRef.current !== isAlternateScreen) {
      isAlternateScreenRef.current = isAlternateScreen;
    }
    return isAlternateScreen;
  }, []);

  // 加载命令历史
  useEffect(() => {
    const loadData = async () => {
      if (window.electronAPI) {
        const historyResult = await window.electronAPI.getCommandHistory();
        if (historyResult.success) {
          setCommandHistory(Array.isArray(historyResult.data?.history) ? historyResult.data.history : []);
        }
      }
    };
    loadData();
  }, [connectionId]);

  // 终端右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!connectionId) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const handleCopy = () => {
    if (xtermRef.current) {
      const selection = xtermRef.current.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection);
      }
    }
    closeContextMenu();
  };

  const handlePaste = () => {
    if (xtermRef.current) {
      navigator.clipboard.readText().then(text => {
        if (text) {
          xtermRef.current?.paste(text);
        }
      });
    }
    closeContextMenu();
  };

  const handlePasteToInput = () => {
    if (!xtermRef.current) {
      closeContextMenu();
      return;
    }

    // 优先获取终端的选中文本，如果没有再尝试从剪贴板读取
    let text = xtermRef.current.getSelection();

    if (text && text.trim()) {
      // 使用终端选中的文本
      pasteToInput(text);
      closeContextMenu();
    } else {
      // 如果终端没有选中文本，尝试从剪贴板读取
      navigator.clipboard.readText().then(clipboardText => {
        if (clipboardText) {
          pasteToInput(clipboardText);
        }
        closeContextMenu();
      }).catch(err => {
        console.error('Failed to read clipboard:', err);
        closeContextMenu();
      });
    }
  };

  const handlePasteToAI = () => {
    if (!xtermRef.current) {
      closeContextMenu();
      return;
    }

    const selectedText = xtermRef.current.getSelection();

    if (selectedText && selectedText.trim()) {
      onPasteToAI?.(selectedText);
      closeContextMenu();
      return;
    }

    navigator.clipboard.readText().then((clipboardText) => {
      if (clipboardText) {
        onPasteToAI?.(clipboardText);
      }
      closeContextMenu();
    }).catch((err) => {
      console.error('Failed to read clipboard:', err);
      closeContextMenu();
    });
  };

  // 辅助函数：处理粘贴到输入栏
  const pasteToInput = (text: string) => {
    if (!xtermRef.current) return;

    // 去掉末尾的换行符，只粘贴到输入栏不自动执行
    const cleanText = text.replace(/[\r\n]+$/, '');

    if (cleanText) {
      // 使用 paste 方法，这会正确地将文本发送到终端并触发 onData 事件
      xtermRef.current.paste(cleanText);
    }
  };

  // 全局键盘监听 - 搜索、字体等
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 搜索和字体快捷键
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setFontSize(prev => Math.min(prev + 2, MAX_TERMINAL_FONT_SIZE));
      }
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        setFontSize(prev => Math.max(prev - 2, MIN_TERMINAL_FONT_SIZE));
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showSearch]);

  // 当 settings 中的 terminalTheme 变化时同步本地状态（处理异步加载）
  useEffect(() => {
    if (settings?.terminalTheme && settings.terminalTheme !== terminalTheme) {
      setTerminalTheme(settings.terminalTheme);
    }
  }, [settings?.terminalTheme]);

  // 当 settings 中的字体设置变化时，同步到终端
  useEffect(() => {
    const nextFontSize = clampTerminalFontSize(settings?.fontSize);
    setFontSize(prev => (prev === nextFontSize ? prev : nextFontSize));
  }, [settings?.fontSize]);

  // 更新终端主题
  const updateTerminalTheme = useCallback(() => {
    if (xtermRef.current && TERMINAL_THEMES[terminalTheme]) {
      xtermRef.current.options.theme = TERMINAL_THEMES[terminalTheme];
    }
  }, [terminalTheme]);

  // 切换主题
  const handleThemeChange = async (newTheme: string) => {
    setTerminalTheme(newTheme);
    if (xtermRef.current && TERMINAL_THEMES[newTheme]) {
      xtermRef.current.options.theme = TERMINAL_THEMES[newTheme];
    }
    setShowThemeSelector(false);

    // 持久化终端主题选择
    if (settings && window.electronAPI) {
      try {
        const newSettings = { ...settings, terminalTheme: newTheme };
        await window.electronAPI.saveSettings(newSettings);
      } catch (error) {
        console.error('Failed to save terminal theme:', error);
      }
    }
  };

  // 初始化/清理 xterm
  useEffect(() => {
    if (!connectionId || !terminalRef.current) {
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      return;
    }

    if (xtermRef.current) {
      return;
    }

    const term = new XTerm({
      theme: TERMINAL_THEMES[terminalTheme],
      fontFamily: getTerminalFontFamily(settings?.fontFamily),
      fontSize: fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: true,
      cursorStyle: 'block',
      scrollback: XTERM_SCROLLBACK_LINES,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);

    term.open(terminalRef.current);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // 拦截 xterm 内部对 Ctrl+F 的处理，交还给我们的全局快捷键
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        return false; // 阻止 xterm 处理，事件冒泡到 window
      }
      return true; // 其他按键正常处理
    });

    // 初始化终端尺寸 - 确保容器有实际尺寸后再 fit 并通知 SSH
    let initialFitDone = false;
    const doInitialFit = () => {
      if (initialFitDone) return;
      if (!fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;

      // 确保容器有实际尺寸
      const rect = terminalRef.current.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;

      initialFitDone = true;
      fitAddonRef.current.fit();
      const { cols, rows } = xtermRef.current;
      if (cols > 0 && rows > 0) {
        resizeSSH(cols, rows);
      }
    };

    // 多次尝试 fit，确保布局稳定后获得正确尺寸
    // 第一次：立即尝试（容器可能已经有尺寸）
    requestAnimationFrame(doInitialFit);
    // 第二次：50ms 后（等待 flex 布局计算完成）
    initTimeoutRef.current = setTimeout(doInitialFit, 50);
    // 第三次：200ms 后（兜底，确保一定能 fit）
    fitTimeoutRef.current = setTimeout(doInitialFit, 200);

    // 窗口 resize 时处理
    const handleWindowResize = () => {
      if (xtermRef.current && fitAddonRef.current && connectionId && terminalRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        if (cols > 0 && rows > 0) {
          resizeSSH(cols, rows);
        }
      }
    };
    window.addEventListener('resize', handleWindowResize);

    term.clear();
    term.write(`\x1b[1;32m=== ${t('terminal.sshConnected')} ===\x1b[0m\r\n`);
    term.write(`\x1b[1;33m${t('terminal.waitingServer')}\x1b[0m\r\n\r\n`);
    currentInputRef.current = '';
    isAlternateScreenRef.current = false;

    const writeParsedDisposable = term.onWriteParsed(() => {
      syncAlternateScreenState();
    });

    // 设置 ResizeObserver 监听容器尺寸变化 - 添加防抖避免频繁触发
    // 跳过初始触发（由 doInitialFit 处理）
    let resizeObserverReady = false;
    setTimeout(() => { resizeObserverReady = true; }, 500);

    resizeObserverRef.current = new ResizeObserver(() => {
      if (!resizeObserverReady) return;
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = setTimeout(() => {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = xtermRef.current;
          if (cols > 0 && rows > 0) {
            resizeSSH(cols, rows);
          }
        }
      }, 100);
    });
    
    if (terminalRef.current) {
      resizeObserverRef.current.observe(terminalRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      if (initTimeoutRef.current) {
        clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      writeParsedDisposable.dispose();
      term.dispose();
      xtermRef.current = null;
    };
  }, [connectionId, resizeSSH, syncAlternateScreenState]);

  // 将命令写入终端（用于从 AI 复制命令到终端输入）
  useEffect(() => {
    (window as any).writeToTerminal = (cmd: string) => {
      if (xtermRef.current) {
        // 使用 paste 将文本插入终端，这会触发 onData 并发送到 SSH
        xtermRef.current.paste(cmd);
      }
    };
    return () => {
      delete (window as any).writeToTerminal;
    };
  }, []);



  // 处理字体大小变化
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.fontSize = fontSize;
      fitAddonRef.current?.fit();
      // 字体变化后同步服务器端终端尺寸
      const { cols, rows } = xtermRef.current;
      resizeSSH(cols, rows);
    }
  }, [fontSize, resizeSSH]);

  // 处理字体族变化
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.fontFamily = getTerminalFontFamily(settings?.fontFamily);
      fitAddonRef.current?.fit();
      const { cols, rows } = xtermRef.current;
      resizeSSH(cols, rows);
    }
  }, [settings?.fontFamily, resizeSSH]);

  // 监听 xterm 输入 - 简单、稳定的方式
  useEffect(() => {
    if (!xtermRef.current || !connectionId) {
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
      return;
    }

    if (onDataDisposableRef.current) {
      return;
    }

    const term = xtermRef.current;

    const onDataDisposable = term.onData((data: string) => {
      // 直接发送到 SSH - 使用同步 IPC 发送，不等待返回值
      if (connectionId && window.electronAPI) {
        window.electronAPI.sshExecuteSync(connectionId, data);
      }

      if (syncAlternateScreenState()) {
        currentInputRef.current = '';
        return;
      }

      // 跟踪当前输入用于保存命令历史
      if (data === '\r') {
        // Enter - 保存命令到历史
        const cmd = currentInputRef.current.trim();
        if (cmd) {
          // 更新 cwd 跟踪 (在保存之前，记录的是执行时的目录)
          const currentCwd = cwdRef.current;

          // 分析 cd 命令来更新 cwd
          const cdMatch = cmd.match(/^cd\s+(.+)$/);
          if (cdMatch) {
            const target = cdMatch[1].trim().replace(/["']/g, '');
            if (target.startsWith('/')) {
              cwdRef.current = target;
            } else if (target === '~' || target === '') {
              cwdRef.current = '~';
            } else if (target === '-') {
              // cd - 无法跟踪，保持不变
            } else if (target === '..') {
              const parts = cwdRef.current.split('/').filter(Boolean);
              parts.pop();
              cwdRef.current = parts.length === 0 ? '/' : '/' + parts.join('/');
            } else if (target.startsWith('~/')) {
              cwdRef.current = target;
            } else {
              // 相对路径
              if (cwdRef.current === '~') {
                cwdRef.current = '~/' + target;
              } else {
                cwdRef.current = cwdRef.current.replace(/\/$/, '') + '/' + target;
              }
            }
          } else if (cmd === 'cd') {
            cwdRef.current = '~';
          }

          (async () => {
            if (window.electronAPI) {
              const { connections, activeConnectionId } = useConnectionStore.getState();
              const connection = connections.find(c => c.id === activeConnectionId);
              const historyItem: CommandHistoryItem = {
                id: Date.now().toString(),
                command: cmd,
                timestamp: Date.now(),
                connectionId: activeConnectionId || '',
                connectionName: connection?.name || 'Unknown',
                executedBy: 'user',
                approved: true,
                cwd: currentCwd,
              };
              await window.electronAPI.addCommandHistory(historyItem);
              // 刷新历史命令
              const historyResult = await window.electronAPI.getCommandHistory();
              if (historyResult.success) {
                setCommandHistory(Array.isArray(historyResult.data?.history) ? historyResult.data.history : []);
              }
            }
          })();
        }
        currentInputRef.current = '';
      } else if (data === '\x7f' || data === '\b') {
        // Backspace
        currentInputRef.current = currentInputRef.current.slice(0, -1);
      } else if (data === '\x03') {
        // Ctrl+C
        currentInputRef.current = '';
      } else if (data === '\x15') {
        // Ctrl+U - 清除整行
        currentInputRef.current = '';
      } else if (data === '\x17') {
        // Ctrl+W - 删除前一个单词
        currentInputRef.current = currentInputRef.current.replace(/\S+\s*$/, '');
      } else if (data.startsWith('\x1b')) {
        // 转义序列 (方向键、功能键等) - 无法可靠跟踪光标移动
        // 如果是上/下方向键(历史切换)，重置跟踪，因为内容已不可靠
        if (data === '\x1b[A' || data === '\x1b[B') {
          currentInputRef.current = '';
        }
        // 其他转义序列忽略
      } else if (data === '\t') {
        // Tab (SSH 服务端补全) - 无法知道补全结果，标记为不可靠
        // 追加一个标记，在保存时会从终端输出中提取实际命令
        currentInputRef.current = '';
      } else if (data.charCodeAt(0) >= 32) {
        // 可打印字符（包括粘贴的多字符文本）
        currentInputRef.current += data;
      }
    });

    onDataDisposableRef.current = onDataDisposable;

    return () => {
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
    };
  }, [connectionId]);

  // 直接监听 SSH 数据并写入 xterm（绕过 store，避免 string diff 导致的渲染问题）
  useEffect(() => {
    if (!connectionId || !window.electronAPI) return;

    const cleanup = window.electronAPI.onSshData(({ connectionId: dataConnId, data, type }) => {
      if (dataConnId !== connectionId || type !== 'data' || !data) return;
      if (xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    sshDataCleanupRef.current = cleanup;

    return () => {
      cleanup();
      sshDataCleanupRef.current = null;
    };
  }, [connectionId]);

  // 监听主题变化并更新终端
  useEffect(() => {
    updateTerminalTheme();
  }, [updateTerminalTheme]);

  // 监听系统主题变化（当 theme 为 'system' 时）
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      updateTerminalTheme();
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme, updateTerminalTheme]);

  // 搜索功能
  useEffect(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  }, [searchQuery]);

  const handleSearchNext = () => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  };

  const handleSearchPrev = () => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findPrevious(searchQuery);
    }
  };

  return (
    <div
      className="terminal-shell"
      onContextMenu={handleContextMenu}
    >
      {/* Terminal Toolbar */}
      <div className="terminal-toolbar">
        <button
          onClick={() => setFontSize(prev => Math.max(prev - 2, MIN_TERMINAL_FONT_SIZE))}
          className="terminal-control"
          title="缩小 (Ctrl+-)"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="terminal-toolbar-badge">{fontSize}px</span>
        <button
          onClick={() => setFontSize(prev => Math.min(prev + 2, MAX_TERMINAL_FONT_SIZE))}
          className="terminal-control"
          title="放大 (Ctrl++)"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={() => setShowSearch(prev => !prev)}
          className={`terminal-control ${showSearch ? 'terminal-control-active' : ''}`}
          title="搜索 (Ctrl+F)"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* 主题选择器 */}
        <div className="relative">
          <button
            onClick={() => setShowThemeSelector(prev => !prev)}
            className="terminal-control"
            title="切换主题"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
            </svg>
          </button>

          {showThemeSelector && (
            <div className="app-popover right-0 min-w-[160px] py-1">
              {Object.keys(TERMINAL_THEMES).map(themeKey => (
                <button
                  key={themeKey}
                  onClick={() => handleThemeChange(themeKey)}
                  className={`app-popover-row text-sm ${
                    terminalTheme === themeKey
                      ? 'bg-teal-600 text-white'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 rounded-sm border border-slate-300 dark:border-slate-600"
                      style={{ background: TERMINAL_THEMES[themeKey].background }}
                    />
                    {THEME_NAMES[themeKey]}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="terminal-search-panel">
          <Search className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.shiftKey ? handleSearchPrev() : handleSearchNext();
              }
            }}
            placeholder="搜索..."
            className="w-48 bg-transparent text-sm text-slate-900 outline-none dark:text-white"
            autoFocus
          />
          <button onClick={handleSearchPrev} className="icon-button h-7 w-7">
            ↑
          </button>
          <button onClick={handleSearchNext} className="icon-button h-7 w-7">
            ↓
          </button>
          <button onClick={() => { setShowSearch(false); setSearchQuery(''); }} className="icon-button h-7 w-7">
            ✕
          </button>
        </div>
      )}

      {/* Terminal Container */}
      <div className="absolute inset-0 p-2">
        <div
          ref={terminalRef}
          className="terminal-frame"
          style={{
            cursor: 'text'
          }}
        />
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onCopy={handleCopy}
            onPaste={handlePaste}
            onPasteToInput={handlePasteToInput}
            onPasteToAI={handlePasteToAI}
            onClose={closeContextMenu}
          />
        )}

      {/* No Connection State */}
      {!connectionId && (
        <div className="terminal-empty-state">
          <div className="text-center">
            <div className="terminal-empty-icon">
              <TerminalIcon className="h-5 w-5" />
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">选择一个连接并点击"连接"开始</p>
          </div>
        </div>
      )}
    </div>
  );
}
