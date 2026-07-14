import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { AlertCircle, Clock3, Search, Terminal as TerminalIcon, WifiOff } from 'lucide-react';
import { useSessionStore } from '../useSessionStore';
import { useTheme } from '../../hooks/useTheme';
import { useI18n } from '../../i18n';
import { useSftpTransferStore } from '../../store/useSftpTransferStore';
import { DEFAULT_REMOTE_PATH } from '../../transfer/transfer-types';
import { useWorkspaceStore } from '../../workspace/useWorkspaceStore';
import type { AppSettings } from '../../../shared/types';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalToolbar } from './TerminalToolbar';
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_THEMES,
  clampTerminalFontSize,
} from './terminal-theme';
import { useTerminalClipboard } from './useTerminalClipboard';
import { useTerminalInputTracking } from './useTerminalInputTracking';
import { useTerminalSearch } from './useTerminalSearch';
import { useXtermInstance } from './useXtermInstance';

interface TerminalProps {
  liveConnectionId: string | null;
  onPasteToAI?: (text: string) => void;
  sessionId: string | null;
  theme?: 'dark' | 'light' | 'system';
  settings?: AppSettings;
}


export { TERMINAL_THEMES } from './terminal-theme';

// 主题名称映射
const THEME_NAMES: Record<string, string> = {
  dark: 'terminal.themeNames.dark',
  light: 'terminal.themeNames.light',
  monokai: 'Monokai',
  solarized: 'Solarized Dark',
  oneDark: 'One Dark',
  nord: 'Nord',
  dracula: 'Dracula',
  github: 'GitHub Dark',
  ubuntu: 'Ubuntu',
};

/** Terminal view that owns xterm rendering and delegates runtime sub-concerns to hooks. */
export function TerminalView({ liveConnectionId, onPasteToAI, sessionId, theme: themeProp, settings }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [fontSize, setFontSize] = useState(() => clampTerminalFontSize(settings?.fontSize));
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState(settings?.terminalTheme || 'dark');
  const [terminalInstanceVersion, setTerminalInstanceVersion] = useState(0);
  const isAlternateScreenRef = useRef(false);
  
  // 如果没有传入 theme，则使用 useTheme hook
  const { theme: hookTheme } = useTheme();
  const { t } = useI18n();
  const theme = themeProp ?? hookTheme;
  const activeSession = useSessionStore((state) => (
    sessionId ? state.sessions[sessionId] : null
  ));
  const terminalOutput = useSessionStore((state) => (
    sessionId ? state.outputs[sessionId] || '' : ''
  ));
  const isLive = Boolean(liveConnectionId);
  const hasSession = Boolean(sessionId);
  const isRestored = Boolean(activeSession?.restoredFromScrollback);
  const hasTerminalOutput = terminalOutput.length > 0;

  const syncAlternateScreenState = useCallback(() => {
    const isAlternateScreen = xtermRef.current?.buffer.active.type === 'alternate';
    if (isAlternateScreenRef.current !== isAlternateScreen) {
      isAlternateScreenRef.current = isAlternateScreen;
    }
    return isAlternateScreen;
  }, []);

  const handleTerminalInstanceVersionChange = useCallback(() => {
    setTerminalInstanceVersion((version) => version + 1);
  }, []);

  const { consumeOutputChunk, resetInputTracking } = useTerminalInputTracking({
    liveConnectionId,
    syncAlternateScreenState,
    terminalInstanceVersion,
    xtermRef,
  });

  const {
    closeSearch,
    searchNext,
    searchPrevious,
    searchQuery,
    setSearchQuery,
    setShowSearch,
    showSearch,
  } = useTerminalSearch({
    maxFontSize: MAX_TERMINAL_FONT_SIZE,
    minFontSize: MIN_TERMINAL_FONT_SIZE,
    searchAddonRef,
    setFontSize,
  });

  const {
    closeContextMenu,
    contextMenu,
    copyTerminalSelectionToClipboard,
    handleCopy,
    handlePaste,
    handlePasteToAI,
    handlePasteToInput,
    setContextMenu,
  } = useTerminalClipboard({ liveConnectionId, onPasteToAI, xtermRef });

  const { renderedOutput, setRenderedOutput } = useXtermInstance({
    copyTerminalSelectionToClipboard,
    fontSize,
    liveConnectionId,
    onInstanceVersionChange: handleTerminalInstanceVersionChange,
    resetInputTracking,
    searchAddonRef,
    sessionId,
    settings,
    syncAlternateScreenState,
    terminalRef,
    terminalTheme,
    xtermRef,
  });

  // 终端右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!sessionId) return;
    e.preventDefault();
    xtermRef.current?.focus();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleTerminalPointerDown = () => {
    xtermRef.current?.focus();
  };

  const handleOpenFileTransfer = useCallback(() => {
    if (!liveConnectionId) {
      return;
    }
    // 终端已解析到非默认 cwd 时跳转；cwd 仍是 ~ 或未解析时保留当前浏览路径，避免误重置
    const sessionCwd = useSessionStore.getState().sessions[liveConnectionId]?.cwd?.trim();
    const browserPath = useSftpTransferStore.getState()
      .browserByConnection[liveConnectionId]?.remotePath;
    const trackedAwayFromHome = Boolean(
      sessionCwd && sessionCwd !== '~' && sessionCwd !== DEFAULT_REMOTE_PATH,
    );
    const targetPath = trackedAwayFromHome
      ? sessionCwd!
      : (browserPath || sessionCwd || DEFAULT_REMOTE_PATH);
    useSftpTransferStore.getState().requestBrowserPath(liveConnectionId, targetPath);
    useWorkspaceStore.getState().setSftpSidebarOpen(true);
    closeContextMenu();
  }, [closeContextMenu, liveConnectionId]);

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

  // 消费 session store 中的输出缓存，统一由 session bridge 写入底层 SSH 事件。
  useEffect(() => {
    if (!sessionId || !xtermRef.current) {
      setRenderedOutput('');
      return;
    }

    const currentOutput = terminalOutput || '';
    const previousOutput = renderedOutput;
    const term = xtermRef.current;

    const applyChunk = (chunk: string) => {
      if (!chunk) {
        return;
      }

      consumeOutputChunk(chunk);
      term.write(chunk);
    };

    if (currentOutput && previousOutput && currentOutput.startsWith(previousOutput)) {
      applyChunk(currentOutput.slice(previousOutput.length));
      setRenderedOutput(currentOutput);
      return;
    }

    if (currentOutput !== previousOutput) {
      term.clear();
      resetInputTracking();
      applyChunk(currentOutput);
      setRenderedOutput(currentOutput);
    }
  }, [
    consumeOutputChunk,
    renderedOutput,
    resetInputTracking,
    setRenderedOutput,
    sessionId,
    terminalOutput,
  ]);

  const terminalStatus = (() => {
    if (!hasSession) {
      return {
        icon: <TerminalIcon className="h-5 w-5" />,
        title: t('terminal.emptyTitle'),
        body: t('terminal.emptyDescription'),
        tone: 'idle',
      };
    }
    if (isRestored) {
      return {
        icon: <Clock3 className="h-5 w-5" />,
        title: t('terminal.restoredTitle'),
        body: t('terminal.restoredDescription'),
        tone: 'restored',
      };
    }
    if (activeSession?.state === 'reconnecting' || activeSession?.state === 'connecting') {
      return {
        icon: <Clock3 className="h-5 w-5" />,
        title: activeSession.state === 'reconnecting' ? t('terminal.reconnectingTitle') : t('terminal.connectingTitle'),
        body: t('terminal.waitingServer'),
        tone: 'waiting',
      };
    }
    if (activeSession?.state === 'error') {
      return {
        icon: <AlertCircle className="h-5 w-5" />,
        title: t('terminal.errorTitle'),
        body: activeSession.lastError || t('common.error'),
        tone: 'error',
      };
    }
    if (!isLive && activeSession?.state === 'closed') {
      return {
        icon: <WifiOff className="h-5 w-5" />,
        title: t('terminal.closedTitle'),
        body: t('terminal.closedDescription'),
        tone: 'closed',
      };
    }
    return null;
  })();

  // 监听系统主题变化（当 theme 为 'system' 时）
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (xtermRef.current && TERMINAL_THEMES[terminalTheme]) {
        xtermRef.current.options.theme = TERMINAL_THEMES[terminalTheme];
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [terminalTheme, theme]);

  return (
    <div
      className="terminal-shell"
      onContextMenu={handleContextMenu}
    >
      <TerminalToolbar
        fontSize={fontSize}
        isSearchOpen={showSearch}
        terminalTheme={terminalTheme}
        themeNames={THEME_NAMES}
        themes={TERMINAL_THEMES}
        translate={t}
        isThemeSelectorOpen={showThemeSelector}
        onDecreaseFontSize={() => setFontSize(prev => Math.max(prev - 2, MIN_TERMINAL_FONT_SIZE))}
        onIncreaseFontSize={() => setFontSize(prev => Math.min(prev + 2, MAX_TERMINAL_FONT_SIZE))}
        onToggleSearch={() => setShowSearch(prev => !prev)}
        onToggleThemeSelector={() => setShowThemeSelector(prev => !prev)}
        onSelectTheme={handleThemeChange}
      />

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
                e.shiftKey ? searchPrevious() : searchNext();
              }
            }}
            placeholder={t('common.search')}
            className="w-48 bg-transparent text-sm text-slate-900 outline-none dark:text-white"
            autoFocus
          />
          <button onClick={searchPrevious} className="icon-button h-7 w-7">
            ↑
          </button>
          <button onClick={searchNext} className="icon-button h-7 w-7">
            ↓
          </button>
          <button onClick={closeSearch} className="icon-button h-7 w-7">
            ✕
          </button>
        </div>
      )}

      {/* Terminal Container */}
      <div className="absolute inset-0 p-2">
        <div
          ref={terminalRef}
          className="terminal-frame"
          onMouseDown={handleTerminalPointerDown}
          style={{
            cursor: 'text'
          }}
        />
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
          <TerminalContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onCopy={handleCopy}
            onPaste={handlePaste}
            onPasteToInput={handlePasteToInput}
            onPasteToAI={handlePasteToAI}
            onOpenFileTransfer={handleOpenFileTransfer}
            onClose={closeContextMenu}
            canPasteToTerminal={isLive}
            canOpenFileTransfer={isLive}
            translate={t}
          />
        )}

      {/* No Connection State */}
      {terminalStatus && hasSession && hasTerminalOutput && (
        <div className={`terminal-state-banner terminal-state-banner-${terminalStatus.tone}`}>
          <span className="terminal-state-banner-icon">{terminalStatus.icon}</span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">{terminalStatus.title}</p>
            <p className="truncate text-[11px] opacity-80">{terminalStatus.body}</p>
          </div>
        </div>
      )}

      {terminalStatus && (!hasSession || !hasTerminalOutput) && (
        <div className={`terminal-state-overlay terminal-state-overlay-${terminalStatus.tone}`}>
          <div className="text-center">
            <div className="terminal-empty-icon">
              {terminalStatus.icon}
            </div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{terminalStatus.title}</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">{terminalStatus.body}</p>
          </div>
        </div>
      )}
    </div>
  );
}
