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
import { downloadTextFile } from '../../connection/backup-utils';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalToolbar } from './TerminalToolbar';
import { MultilinePasteDialog } from './MultilinePasteDialog';
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_THEMES,
  clampTerminalFontSize,
} from './terminal-theme';
import {
  clampTerminalScrollback,
  resolveTerminalRuntimeSettings,
  type TerminalCursorStyle,
} from './terminal-settings';
import {
  buildSessionLogFilename,
  resolveSessionLogText,
  serializeXtermBuffer,
} from './session-log';
import type { ShellIntegrationState } from './shell-integration';
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
  /** 工具栏改字体/主题时回写全局设置并持久化 */
  onSettingsPatch?: (patch: Partial<AppSettings>) => void | Promise<void>;
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
export function TerminalView({
  liveConnectionId,
  onPasteToAI,
  sessionId,
  theme: themeProp,
  settings,
  onSettingsPatch,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [fontSize, setFontSize] = useState(() => clampTerminalFontSize(settings?.fontSize));
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState(settings?.terminalTheme || 'dark');
  const [terminalInstanceVersion, setTerminalInstanceVersion] = useState(0);
  const [pastePreview, setPastePreview] = useState<{ previewText: string; preparedText: string } | null>(null);
  const [shellState, setShellState] = useState<ShellIntegrationState | null>(null);
  const isAlternateScreenRef = useRef(false);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  const runtimeSettings = resolveTerminalRuntimeSettings(settings);

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

  const handleMultilinePasteRequest = useCallback((previewText: string, preparedText: string) => {
    setPastePreview({ previewText, preparedText });
  }, []);

  const handleShellIntegrationStateChange = useCallback((state: ShellIntegrationState) => {
    setShellState(state);
  }, []);

  const { consumeOutputChunk, resetInputTracking } = useTerminalInputTracking({
    liveConnectionId,
    syncAlternateScreenState,
    terminalInstanceVersion,
    xtermRef,
  });

  /** 写入本地字号并持久化（工具栏 +/- 与 Ctrl+/- 共用）。 */
  const commitFontSize = useCallback((nextSize: number) => {
    const clamped = clampTerminalFontSize(nextSize);
    if (clamped === fontSizeRef.current) {
      return;
    }
    fontSizeRef.current = clamped;
    setFontSize(clamped);
    if (onSettingsPatch) {
      void onSettingsPatch({ fontSize: clamped });
      return;
    }
    // 无回写回调时仍尽量落盘，避免刷新丢失
    if (settings && window.electronAPI) {
      void window.electronAPI.saveSettings({ ...settings, fontSize: clamped }).catch((error) => {
        console.error('Failed to save terminal font size:', error);
      });
    }
  }, [onSettingsPatch, settings]);

  const setFontSizeAndPersist = useCallback((value: number | ((prev: number) => number)) => {
    const prev = fontSizeRef.current;
    const next = typeof value === 'function' ? value(prev) : value;
    commitFontSize(next);
  }, [commitFontSize]);

  /** 局部终端设置 patch 并持久化。 */
  const patchTerminalSetting = useCallback((patch: Partial<AppSettings>) => {
    if (onSettingsPatch) {
      void onSettingsPatch(patch);
      return;
    }
    if (settings && window.electronAPI) {
      void window.electronAPI.saveSettings({ ...settings, ...patch }).catch((error) => {
        console.error('Failed to save terminal settings:', error);
      });
    }
  }, [onSettingsPatch, settings]);

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
    setFontSize: setFontSizeAndPersist,
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
  } = useTerminalClipboard({
    liveConnectionId,
    onPasteToAI,
    xtermRef,
    onMultilinePasteRequest: handleMultilinePasteRequest,
  });

  const { renderedOutput, setRenderedOutput, consumeShellIntegration } = useXtermInstance({
    copyTerminalSelectionToClipboard,
    fontSize,
    liveConnectionId,
    onInstanceVersionChange: handleTerminalInstanceVersionChange,
    onMultilinePasteRequest: handleMultilinePasteRequest,
    resetInputTracking,
    searchAddonRef,
    sessionId,
    settings,
    syncAlternateScreenState,
    terminalRef,
    terminalTheme,
    xtermRef,
    onShellIntegrationStateChange: handleShellIntegrationStateChange,
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
    // 终端右键：优先用已解析的 cwd（含绝对路径）；否则保留当前浏览路径
    const sessionCwd = useSessionStore.getState().sessions[liveConnectionId]?.cwd?.trim();
    const shellCwd = shellState?.cwd?.trim();
    const browserPath = useSftpTransferStore.getState()
      .browserByConnection[liveConnectionId]?.remotePath;
    const preferredCwd = shellCwd || sessionCwd;
    const hasTrackedCwd = Boolean(preferredCwd && preferredCwd.length > 0);
    const targetPath = hasTrackedCwd
      ? preferredCwd!
      : (browserPath || DEFAULT_REMOTE_PATH);
    useSftpTransferStore.getState().requestBrowserPath(liveConnectionId, targetPath);
    useWorkspaceStore.getState().setSftpSidebarOpen(true);
    closeContextMenu();
  }, [closeContextMenu, liveConnectionId, shellState?.cwd]);

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

  // 切换主题（同步落盘，与设置页一致）
  const handleThemeChange = async (newTheme: string) => {
    setTerminalTheme(newTheme);
    if (xtermRef.current && TERMINAL_THEMES[newTheme]) {
      xtermRef.current.options.theme = TERMINAL_THEMES[newTheme];
    }
    setShowThemeSelector(false);

    if (onSettingsPatch) {
      try {
        await onSettingsPatch({ terminalTheme: newTheme });
      } catch (error) {
        console.error('Failed to save terminal theme:', error);
      }
      return;
    }
    if (settings && window.electronAPI) {
      try {
        await window.electronAPI.saveSettings({ ...settings, terminalTheme: newTheme });
      } catch (error) {
        console.error('Failed to save terminal theme:', error);
      }
    }
  };

  const handleConfirmPaste = useCallback(() => {
    if (!pastePreview) {
      return;
    }
    const text = pastePreview.preparedText;
    setPastePreview(null);
    if (text && liveConnectionId && window.electronAPI) {
      window.electronAPI.sshExecuteSync(liveConnectionId, text);
    }
  }, [liveConnectionId, pastePreview]);

  const handleCancelPaste = useCallback(() => {
    // 取消不发送任何内容
    setPastePreview(null);
  }, []);

  const handleSaveLog = useCallback(() => {
    const xtermText = serializeXtermBuffer(xtermRef.current);
    const content = resolveSessionLogText(xtermText, terminalOutput);
    if (!content.trim()) {
      console.info(t('terminal.logEmpty'));
      return;
    }
    const filename = buildSessionLogFilename(sessionId);
    downloadTextFile(filename, content, 'text/plain;charset=utf-8');
  }, [sessionId, t, terminalOutput]);

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
      consumeShellIntegration(chunk);
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
    consumeShellIntegration,
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
        isSettingsOpen={showSettingsPanel}
        scrollback={runtimeSettings.scrollback}
        cursorStyle={runtimeSettings.cursorStyle}
        cursorBlink={runtimeSettings.cursorBlink}
        copyOnSelect={runtimeSettings.copyOnSelect}
        shellIntegration={runtimeSettings.shellIntegration}
        shellCwd={shellState?.cwd ?? null}
        onDecreaseFontSize={() => commitFontSize(fontSizeRef.current - 2)}
        onIncreaseFontSize={() => commitFontSize(fontSizeRef.current + 2)}
        onToggleSearch={() => setShowSearch(prev => !prev)}
        onToggleThemeSelector={() => {
          setShowThemeSelector(prev => !prev);
          setShowSettingsPanel(false);
        }}
        onToggleSettings={() => {
          setShowSettingsPanel(prev => !prev);
          setShowThemeSelector(false);
        }}
        onSelectTheme={handleThemeChange}
        onScrollbackChange={(value) => patchTerminalSetting({ terminalScrollback: clampTerminalScrollback(value) })}
        onCursorStyleChange={(value: TerminalCursorStyle) => patchTerminalSetting({ terminalCursorStyle: value })}
        onCursorBlinkChange={(value) => patchTerminalSetting({ terminalCursorBlink: value })}
        onCopyOnSelectChange={(value) => patchTerminalSetting({ terminalCopyOnSelect: value })}
        onShellIntegrationChange={(value) => patchTerminalSetting({ terminalShellIntegration: value })}
        onSaveLog={handleSaveLog}
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

      <MultilinePasteDialog
        isOpen={Boolean(pastePreview)}
        previewText={pastePreview?.previewText || ''}
        translate={t}
        onConfirm={handleConfirmPaste}
        onCancel={handleCancelPaste}
      />

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
