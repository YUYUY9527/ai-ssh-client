import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { AlertCircle, ChevronDown, ChevronUp, Clock3, Download, Search, Terminal as TerminalIcon, Upload, WifiOff, X } from 'lucide-react';
import { useSessionStore } from '../useSessionStore';
import { useTheme } from '../../hooks/useTheme';
import { useI18n } from '../../i18n';
import { useSftpTransferStore } from '../../store/useSftpTransferStore';
import { useAgentStore } from '../../store/useAgentStore';
import { DEFAULT_REMOTE_PATH } from '../../transfer/transfer-types';
import { useWorkspaceStore } from '../../workspace/useWorkspaceStore';
import type { AppSettings } from '../../../shared/types';
import { downloadTextFile } from '../../connection/backup-utils';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalToolbar } from './TerminalToolbar';
import { MultilinePasteDialog } from './MultilinePasteDialog';
import { CastPlayerModal } from './CastPlayerModal';
import { MobileKeyBar } from './MobileKeyBar';
import { createCastRecorder, type CastRecorder } from './session-recorder';
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
import { normalizeHistoryPath } from '../../history/command-history-index';
import {
  extractCwdFromTerminalOutput,
  resolveTransferOpenPath,
  shouldReplaceCwd,
} from './terminal-cwd';
import { planTerminalOutputSync } from './terminal-output-sync';
import { planReplayCalibration, stripReplayTerminalQueries } from './terminal-replay';
import {
  createProgressWrapState,
  guardCarriageReturnProgress,
  releaseProgressWrap,
} from './terminal-progress-wrap';
import { prepareTerminalPaste, wrapBracketedPaste } from './paste-safety';
import { buildVimSafePasteSequence, isVimWithoutBracketedPaste } from './vim-paste';
import {
  createTerminalModeState,
  emitTerminalModeRestore,
  loadTerminalModeState,
  saveTerminalModeState,
  scanTerminalModes,
  type TerminalModeState,
} from './terminal-modes';
import {
  applyTerminalHighlights,
  compileHighlightRules,
} from './terminal-highlight';
import {
  ZMODEM_CANCEL_SEQUENCE,
  detectZmodemSequence,
  parseSzCommandFiles,
  resolveRemotePath,
  type ZmodemTriggerKind,
} from './terminal-zmodem';
import { useCommandHistoryStore } from '../../history/useCommandHistoryStore';
import { ALT_ENTER_SEQUENCE } from './terminal-alt';
import { useTerminalClipboard } from './useTerminalClipboard';
import { useTerminalInputTracking } from './useTerminalInputTracking';
import { useTerminalSearch } from './useTerminalSearch';
import { useXtermInstance } from './useXtermInstance';
import {
  TerminalAgentDock,
  type TerminalAgentDraftPaste,
  type TerminalAgentNotice,
} from './TerminalAgentDock';
import {
  isAgentTaskRunningInSession,
  isShellPromptReadyForAgent,
  parseTerminalAgentPaste,
  resolveTerminalAgentEscapeAction,
  submitAgentInput,
  type AgentSubmissionError,
} from '../../agent/terminal-agent-chat';

interface TerminalProps {
  liveConnectionId: string | null;
  onPasteToAI?: (text: string) => void;
  onOpenAISettings?: () => void;
  sessionId: string | null;
  theme?: 'dark' | 'light' | 'system';
  settings?: AppSettings;
  /** 工具栏改字体/主题时回写全局设置并持久化 */
  onSettingsPatch?: (patch: Partial<AppSettings>) => void | Promise<void>;
  /** 分屏等紧凑布局下减小终端内边距，收窄面板之间的空隙 */
  compact?: boolean;
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

/**
 * 把 replay 前记录的模式恢复序列并入待写入内容：
 * 若重放内容以 1049h 开头（进入 alt screen），恢复序列插在其后（进 alt 再设模式），
 * 否则直接前置（normal buffer 下也一样）。
 */
function withModeRestore(restore: string, chunk: string): string {
  if (!restore) {
    return chunk;
  }
  if (chunk.startsWith(ALT_ENTER_SEQUENCE)) {
    return ALT_ENTER_SEQUENCE + restore + chunk.slice(ALT_ENTER_SEQUENCE.length);
  }
  return restore + chunk;
}

/** 终端模式持久化用的 storage（浏览器无 sessionStorage 时返回 null，交由调用方降级）。 */
function getModeStorage(): Storage | null {
  return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
}

/** Terminal view that owns xterm rendering and delegates runtime sub-concerns to hooks. */
export function TerminalView({
  liveConnectionId,
  onPasteToAI,
  onOpenAISettings,
  sessionId,
  theme: themeProp,
  settings,
  onSettingsPatch,
  compact,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [fontSize, setFontSize] = useState(() => clampTerminalFontSize(settings?.fontSize));
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState(settings?.terminalTheme || 'dark');
  const [terminalInstanceVersion, setTerminalInstanceVersion] = useState(0);
  const [isAlternateScreen, setIsAlternateScreen] = useState(false);
  const [pastePreview, setPastePreview] = useState<{ previewText: string; preparedText: string; vimSafe: boolean } | null>(null);
  const [shellState, setShellState] = useState<ShellIntegrationState | null>(null);
  const [agentDockOpenToken, setAgentDockOpenToken] = useState(0);
  const [agentDockFocusToken, setAgentDockFocusToken] = useState(0);
  const [agentDockCollapseToken, setAgentDockCollapseToken] = useState(0);
  const [agentDockPastedDraft, setAgentDockPastedDraft] = useState<TerminalAgentDraftPaste | null>(null);
  const [agentDockNotice, setAgentDockNotice] = useState<TerminalAgentNotice | null>(null);
  const isAlternateScreenRef = useRef(false);
  /** 用户按 Esc 或停止按钮中断过的任务 id：用于停靠面板展示「已中断」状态。 */
  const interruptedAgentTaskIdRef = useRef<string | null>(null);
  /** `useTerminalInputTracking` 在 interruptAgentTask 之后才调用，用 ref 打通。 */
  const clearTrackedInputRef = useRef<() => void>(() => {});
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  /** 进度条原地刷新时临时关闭自动换行，防止超宽进度每帧新增一行。 */
  const progressWrapStateRef = useRef(createProgressWrapState());
  const progressWrapTimerRef = useRef<number | null>(null);
  /** 远端全屏程序一次性声明的终端模式（bracketed paste / 鼠标 / 光标键…），replay 后恢复。 */
  const terminalModeStateRef = useRef<TerminalModeState>(createTerminalModeState());
  const lastModePersistRef = useRef(0);

  // 会话切换/首次挂载时从 sessionStorage 载入该会话上次记录的模式（覆盖缓冲已截断的场景）。
  useEffect(() => {
    terminalModeStateRef.current = sessionId
      ? loadTerminalModeState(getModeStorage(), sessionId)
      : createTerminalModeState();
  }, [sessionId]);

  const persistModes = useCallback(() => {
    saveTerminalModeState(getModeStorage(), sessionId, terminalModeStateRef.current);
  }, [sessionId]);

  // 每段输出增量扫描模式，并节流持久化（写 sessionStorage 是同步的，避免高频写）。
  const feedModes = useCallback(
    (chunk: string) => {
      if (!chunk) {
        return;
      }
      scanTerminalModes(terminalModeStateRef.current, chunk);
      const now = Date.now();
      if (now - lastModePersistRef.current >= 1000) {
        lastModePersistRef.current = now;
        persistModes();
      }
    },
    [persistModes],
  );

  const runtimeSettings = resolveTerminalRuntimeSettings(settings);

  // 如果没有传入 theme，则使用 useTheme hook
  const { theme: hookTheme } = useTheme();
  const { t } = useI18n();
  const theme = themeProp ?? hookTheme;
  const agentTaskId = useAgentStore((state) => state.currentTask?.id || null);

  useEffect(() => {
    // 换任务就丢掉「被中断过」的标记：它只对当初那个任务有效
    if (agentTaskId && interruptedAgentTaskIdRef.current && interruptedAgentTaskIdRef.current !== agentTaskId) {
      interruptedAgentTaskIdRef.current = null;
    }
  }, [agentTaskId]);

  useEffect(() => {
    setAgentDockNotice(null);
  }, [sessionId]);

  const handleTerminalAgentInput = useCallback((text: string) => {
    setAgentDockOpenToken((count) => count + 1);
    const result = submitAgentInput(text, sessionId);
    if (result.ok) {
      if (result.action.type === 'new-conversation') {
        setAgentDockNotice({
          id: Date.now(),
          tone: 'info',
          message: t('terminal.agentNewConversation'),
        });
      } else if (result.action.type === 'approval') {
        setAgentDockNotice({
          id: Date.now(),
          tone: 'info',
          message: t(
            result.action.result === 'approved'
              ? 'terminal.agentApprovalAccepted'
              : 'terminal.agentApprovalRejected',
          ),
        });
      } else {
        setAgentDockNotice(null);
      }
      return;
    }

    const errorKeys: Record<AgentSubmissionError, string> = {
      empty: 'terminal.agentInputEmpty',
      disabled: 'agent.errors.disabled',
      noProvider: 'agent.errors.noProvider',
      noConnection: 'agent.errors.noConnection',
      taskRunning: 'agent.errors.taskRunning',
      approvalResponseRequired: 'terminal.agentApprovalReplyRequired',
      wrongSession: 'agent.errors.wrongSession',
    };
    setAgentDockNotice({
      id: Date.now(),
      tone: 'error',
      message: t(errorKeys[result.error]),
    });
  }, [sessionId, t]);

  /**
   * 中断正在跑的任务。
   * 顺序不能反：先让网关掐断远端在途命令（`agentPauseTask`），再让 store 进入结束态。
   */
  const interruptAgentTask = useCallback(() => {
    const state = useAgentStore.getState();
    const task = state.currentTask;
    interruptedAgentTaskIdRef.current = task?.id || null;
    void window.electronAPI?.agentPauseTask?.(task?.connectionId || sessionId || undefined);
    state.cancelTask();
    clearTrackedInputRef.current();
  }, [sessionId]);

  const isAgentTaskRunningHere = useCallback(
    () => isAgentTaskRunningInSession({
      sessionId,
      currentTaskState: useAgentStore.getState().currentTask?.state ?? null,
      currentTaskConnectionId: useAgentStore.getState().currentTask?.connectionId ?? null,
      agentState: useAgentStore.getState().agentState,
    }),
    [sessionId],
  );

  /**
   * Esc 仅在本会话有 Agent 正在运行时中断任务；全屏程序（vim/less/top）中始终放行。
   */
  const handleEscapeKey = useCallback((): boolean => {
    if (isAlternateScreenRef.current) {
      return false;
    }
    const action = resolveTerminalAgentEscapeAction({
      isTaskRunningHere: isAgentTaskRunningHere(),
      isFollowUpActive: false,
    });
    if (action === 'interrupt-task') {
      interruptAgentTask();
      return true;
    }
    return false;
  }, [interruptAgentTask, isAgentTaskRunningHere]);

  const isAgentTaskInterrupted = useCallback(
    (taskId: string) => interruptedAgentTaskIdRef.current === taskId,
    [],
  );

  const handleClearAgentNotice = useCallback(() => {
    setAgentDockNotice(null);
  }, []);

  const handleFocusTerminal = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

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
      setIsAlternateScreen(isAlternateScreen);
    }
    return isAlternateScreen;
  }, []);

  const handleTerminalInstanceVersionChange = useCallback(() => {
    isAlternateScreenRef.current = false;
    setIsAlternateScreen(false);
    setTerminalInstanceVersion((version) => version + 1);
  }, []);

  const handleMultilinePasteRequest = useCallback((previewText: string, preparedText: string) => {
    setPastePreview({ previewText, preparedText, vimSafe: isVimWithoutBracketedPaste(xtermRef.current) });
  }, []);

  const handleShellIntegrationStateChange = useCallback((state: ShellIntegrationState) => {
    setShellState(state);
    // OSC7 一般为绝对 PWD，同步到会话；不让后续 ~ 提示符降级覆盖
    const cwd = state.cwd?.trim();
    if (cwd && liveConnectionId) {
      const normalized = normalizeHistoryPath(cwd);
      const current = useSessionStore.getState().sessions[liveConnectionId]?.cwd;
      if (shouldReplaceCwd(current, normalized)) {
        useSessionStore.getState().setSessionCwd(liveConnectionId, normalized);
      }
    }
  }, [liveConnectionId]);

  const {
    consumeOutputChunk,
    resetInputTracking,
    clearTrackedInput,
    beginSuspendInputForward,
    endSuspendInputForward,
    getCurrentInput,
    getCwdTrackingSnapshot,
    recordPastedInput,
  } = useTerminalInputTracking({
    liveConnectionId,
    onAgentInput: handleTerminalAgentInput,
    syncAlternateScreenState,
    terminalInstanceVersion,
    xtermRef,
  });

  // Esc 处理在 xterm 的键盘回调里同步执行，拿不到最新的 useCallback 引用；
  // 用 ref 转发，避免出现「按了没反应」的一拍延迟。
  clearTrackedInputRef.current = clearTrackedInput;

  const canSubmitPastedAgentInput = useCallback(() => {
    const activeBuffer = xtermRef.current?.buffer.active;
    if (!activeBuffer || activeBuffer.type === 'alternate') {
      return false;
    }
    const bufferLine = activeBuffer
      .getLine(activeBuffer.cursorY)
      ?.translateToString(true) || '';
    return isShellPromptReadyForAgent(
      bufferLine,
      getCurrentInput(),
    );
  }, [getCurrentInput, xtermRef]);

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

  // 稳定的判断函数：供搜索 hook 判断当前是否在全屏程序，避免每次渲染重挂监听。
  const isAlternateScreenActive = useCallback(
    () => isAlternateScreenRef.current,
    [],
  );

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
    isAlternateScreenActive,
  });

  const handlePasteSelectedToAI = useCallback((text: string) => {
    const cleanText = text.replace(/[\r\n]+$/, '');
    if (!cleanText) {
      return;
    }
    setAgentDockPastedDraft({ id: Date.now(), text: cleanText });
    onPasteToAI?.(cleanText);
  }, [onPasteToAI]);

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
    onAgentInput: handleTerminalAgentInput,
    canSubmitPastedAgentInput,
    onPasteToAI: handlePasteSelectedToAI,
    xtermRef,
    onMultilinePasteRequest: handleMultilinePasteRequest,
    recordPastedInput,
  });

  const { renderedOutput, setRenderedOutput, consumeShellIntegration } = useXtermInstance({
    copyTerminalSelectionToClipboard,
    fontSize,
    liveConnectionId,
    onAgentInput: handleTerminalAgentInput,
    canSubmitPastedAgentInput,
    onEscapeKey: handleEscapeKey,
    onInstanceVersionChange: handleTerminalInstanceVersionChange,
    onMultilinePasteRequest: handleMultilinePasteRequest,
    recordPastedInput,
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

  const scheduleProgressWrapRelease = useCallback(() => {
    if (progressWrapTimerRef.current != null) {
      window.clearTimeout(progressWrapTimerRef.current);
    }
    // 进度更新通常 100ms 左右一帧；短暂空闲后恢复自动换行，避免影响后续普通输出。
    progressWrapTimerRef.current = window.setTimeout(() => {
      progressWrapTimerRef.current = null;
      const term = xtermRef.current;
      if (!term) {
        progressWrapStateRef.current.active = false;
        return;
      }
      const restore = releaseProgressWrap(progressWrapStateRef.current);
      if (restore) {
        term.write(restore);
      }
    }, 500);
  }, []);

  const compiledHighlightRules = useMemo(
    () => (settings?.terminalHighlightsEnabled ? compileHighlightRules(settings?.terminalHighlightRules) : []),
    [settings?.terminalHighlightsEnabled, settings?.terminalHighlightRules],
  );
  const [zmodemPrompt, setZmodemPrompt] = useState<{ kind: ZmodemTriggerKind; files: string[]; busy: boolean; message?: string } | null>(null);
  const lastZmodemTriggerRef = useRef(0);

  /** 写入终端输出；对超宽 \r 进度条临时关闭自动换行，并按需应用关键词高亮。 */
  const writeProgressGuarded = useCallback((chunk: string, onWritten?: () => void) => {
    const term = xtermRef.current;
    if (!term) {
      onWritten?.();
      return;
    }
    const isAlt = term.buffer.active.type === 'alternate';
    const highlighted = compiledHighlightRules.length > 0
      ? applyTerminalHighlights(chunk, compiledHighlightRules, isAlt)
      : chunk;
    const guarded = guardCarriageReturnProgress(highlighted, progressWrapStateRef.current);
    if (onWritten) {
      term.write(guarded, onWritten);
    } else {
      term.write(guarded);
    }
    if (progressWrapStateRef.current.active) {
      scheduleProgressWrapRelease();
    } else if (progressWrapTimerRef.current != null) {
      window.clearTimeout(progressWrapTimerRef.current);
      progressWrapTimerRef.current = null;
    }
  }, [compiledHighlightRules, scheduleProgressWrapRelease]);

  useEffect(() => () => {
    if (progressWrapTimerRef.current != null) {
      window.clearTimeout(progressWrapTimerRef.current);
      progressWrapTimerRef.current = null;
    }
    progressWrapStateRef.current.active = false;
  }, []);

  // 终端右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!sessionId) return;
    // 全屏程序自己在处理鼠标（vim: set mouse=a）时，右键是它的操作，
    // 只拦掉浏览器默认菜单，不弹我们自己的菜单，免得把 vim 的右键操作吞掉。
    const term = xtermRef.current;
    if (term?.buffer.active.type === 'alternate' && term.modes?.mouseTrackingMode !== 'none') {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    xtermRef.current?.focus();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleTerminalPointerDown = () => {
    setAgentDockCollapseToken((count) => count + 1);
    xtermRef.current?.focus();
  };

  const handleOpenAgentDock = useCallback(() => {
    if (!sessionId) {
      return;
    }
    setAgentDockOpenToken((count) => count + 1);
    setAgentDockFocusToken((count) => count + 1);
  }, [sessionId]);

  const handleInsertCommandToTerminal = useCallback((command: string) => {
    const trimmed = command.trim();
    if (!trimmed || !liveConnectionId || !window.electronAPI) {
      return;
    }
    if (trimmed.includes('\n')) {
      handleMultilinePasteRequest(trimmed, trimmed);
      return;
    }
    try {
      window.electronAPI.sshExecuteSync(liveConnectionId, trimmed);
      xtermRef.current?.focus();
    } catch (error) {
      console.warn('Failed to insert command into terminal', error);
    }
  }, [handleMultilinePasteRequest, liveConnectionId]);

  const handleOpenFileTransfer = useCallback(() => {
    if (!liveConnectionId) {
      return;
    }
    closeContextMenu();

    const connectionId = liveConnectionId;
    const outputKey = sessionId || connectionId;

    void (async () => {
      // 1) 优先探测交互 shell 真实 PWD（不依赖提示符格式 / 过期 OSC7）
      let probedCwd: string | null = null;
      try {
        const probe = window.electronAPI?.sshProbePwd;
        // 全屏程序（vim/nano）前台时，探测命令的字符会被打进编辑器缓冲区、改坏文件，
        // 此时跳过探测，退回到屏幕/追踪/story 解析。
        if (probe && xtermRef.current?.buffer.active.type !== 'alternate') {
          const result = await probe(connectionId);
          if (result.success && result.data?.cwd?.trim()) {
            probedCwd = result.data.cwd.trim();
            useSessionStore.getState().setSessionCwd(
              connectionId,
              normalizeHistoryPath(probedCwd),
            );
          }
        }
      } catch (error) {
        console.warn('sshProbePwd failed, fallback to local cwd parse', error);
      }

      // 2) 回退：屏幕提示符 / 追踪尾部 / store / 会话 / OSC7
      const storeOutput = useSessionStore.getState().outputs[outputKey] || '';
      const tracking = getCwdTrackingSnapshot();
      const xtermOutput = serializeXtermBuffer(xtermRef.current);
      const livePromptCwd = probedCwd
        || extractCwdFromTerminalOutput(xtermOutput)
        || extractCwdFromTerminalOutput(tracking.outputTail)
        || extractCwdFromTerminalOutput(storeOutput);
      const sessionCwd = (
        useSessionStore.getState().sessions[connectionId]?.cwd
        || tracking.cwd
        || ''
      ).trim();
      const shellCwd = shellState?.cwd?.trim();
      const browserPath = useSftpTransferStore.getState()
        .browserByConnection[connectionId]?.remotePath;
      const targetPath = resolveTransferOpenPath({
        livePromptCwd,
        shellCwd,
        sessionCwd,
        browserPath,
        fallbackPath: DEFAULT_REMOTE_PATH,
      });

      useSftpTransferStore.getState().requestBrowserPath(connectionId, targetPath);
      useWorkspaceStore.getState().setSftpSidebarOpen(true);
    })();
  }, [closeContextMenu, getCwdTrackingSnapshot, liveConnectionId, sessionId, shellState?.cwd]);

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
    const agentCommand = parseTerminalAgentPaste(text);
    if (agentCommand && canSubmitPastedAgentInput()) {
      handleTerminalAgentInput(agentCommand.text);
      return;
    }
    if (text && liveConnectionId && window.electronAPI) {
      // 多行粘贴会被远端逐行执行：让输入行追踪失效，避免残留内容混进下一次提交
      recordPastedInput(text);
      const bracketed = xtermRef.current?.modes?.bracketedPasteMode;
      window.electronAPI.sshExecuteSync(
        liveConnectionId,
        wrapBracketedPaste(prepareTerminalPaste(text), bracketed),
      );
    }
  }, [canSubmitPastedAgentInput, handleTerminalAgentInput, liveConnectionId, pastePreview, recordPastedInput]);

  const handleCancelPaste = useCallback(() => {
    // 取消不发送任何内容
    setPastePreview(null);
  }, []);

  /** 旧版 Vim：临时开启 :set paste 粘贴，避免 autoindent/注释符污染。 */
  const handleVimSafePaste = useCallback(() => {
    if (!pastePreview) {
      return;
    }
    const text = pastePreview.previewText;
    setPastePreview(null);
    if (!text || !liveConnectionId || !window.electronAPI) {
      return;
    }
    recordPastedInput(text);
    window.electronAPI.sshExecuteSync(liveConnectionId, buildVimSafePasteSequence(text));
  }, [liveConnectionId, pastePreview, recordPastedInput]);

  /**
   * 重放后校准终端状态（见 terminal-replay）：
   * - chunk 被行截断时可能丢失 \x1b[?1049h，xterm 停在 normal buffer
   *   （症状：右侧滚动条出现、vim 向下滚动丢内容）→ 补写 1049h 恢复 alt screen；
   * - 程序确认在全屏模式时发送 Ctrl+L（vim 默认映射为重绘，nano 也全屏重绘），
   *   让全屏程序补齐截断丢失的画面（nano 会重建标题/状态栏/帮助栏）。
   */
  const calibrateAfterReplay = useCallback((chunk: string, wasInAlternateScreen: boolean) => {
    if (!liveConnectionId || !xtermRef.current) {
      return;
    }
    const plan = planReplayCalibration(
      chunk,
      xtermRef.current.buffer.active.type === 'alternate',
      wasInAlternateScreen,
    );
    if (plan.write) {
      xtermRef.current.write(plan.write);
      castRecorderRef.current?.recordOutput(plan.write);
    }
    if (plan.redraw && window.electronAPI) {
      try {
        window.electronAPI.sshExecuteSync(liveConnectionId, '\x0c');
      } catch {
        // 忽略：写入失败时后续输出仍会继续同步
      }
    }
  }, [liveConnectionId]);

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
    const plan = planTerminalOutputSync(previousOutput, currentOutput);

    if (plan.action === 'noop') {
      return;
    }

    const applyChunk = (chunk: string, allowZmodem = false) => {
      if (!chunk) {
        return;
      }
      let nextChunk = chunk;
      if (allowZmodem && settings?.terminalZmodem !== false && liveConnectionId) {
        const zmodem = detectZmodemSequence(chunk);
        if (zmodem.kind) {
          nextChunk = zmodem.cleanedChunk;
          const now = Date.now();
          if (now - lastZmodemTriggerRef.current > 1500) {
            lastZmodemTriggerRef.current = now;
            // 立刻发送取消序列让远端 rz/sz 退出，避免终端被二进制帧锁死
            try {
              window.electronAPI?.sshExecuteSync(liveConnectionId, ZMODEM_CANCEL_SEQUENCE);
            } catch { /* ignore */ }
            let szFiles: string[] = [];
            if (zmodem.kind === 'sz') {
              const history = useCommandHistoryStore.getState().items;
              const latest = history.find((item) => item.connectionId === liveConnectionId || item.connectionId === sessionId);
              if (latest?.command) {
                szFiles = parseSzCommandFiles(latest.command);
              }
            }
            setZmodemPrompt({ kind: zmodem.kind, files: szFiles, busy: false });
          }
        }
      }
      if (!nextChunk) return;
      feedModes(nextChunk);
      consumeOutputChunk(nextChunk);
      consumeShellIntegration(nextChunk);
      writeProgressGuarded(nextChunk);
    };

    if (plan.action === 'append') {
      // 增量写入：允许 xterm 对直播 OSC 查询正常 onData 应答
      applyChunk(plan.chunk, true);
      setRenderedOutput(currentOutput);
      return;
    }

    // replay：初始装载 / store 截断错位 / 显式清空；挂起 onData，防止历史查询应答打回 PTY 形成死循环
    beginSuspendInputForward();
    let released = false;
    const releaseSuspend = () => {
      if (released) {
        return;
      }
      released = true;
      endSuspendInputForward();
    };
    // 记录重放前的 alt screen 状态：截断窗口滑掉 1049h 时（nano 场景），
    // 本端仍知道远端在全屏模式，校准据此补头 + 让远端 Ctrl+L 重绘。
    const wasInAlternateScreen = xtermRef.current?.buffer.active.type === 'alternate';
    try {
      // 用 reset 而非 clear：干净重建两个 buffer 与状态机。clear 只清当前视口，
      // vim 等全屏程序感知不到屏幕被清，后续增量输出画在残画面上 → 内容缺失。
      if (progressWrapTimerRef.current != null) {
        window.clearTimeout(progressWrapTimerRef.current);
        progressWrapTimerRef.current = null;
      }
      // reset() 会把 DECAWM 恢复为开启，状态必须同步复位，否则重放时不会再关闭自动换行。
      progressWrapStateRef.current.active = false;
      // 先扫描本次重放内容里的 DECSET，再与已持久化的历史模式合并；reset 会清空全部
      // 一次性模式声明，重放后按记录补回来（否则 vim 鼠标/ bracketed paste/光标键失效）。
      if (plan.chunk) {
        // 重放窗口是完整独立的一段，不能与上一次 append 残留的悬挂尾拼接。
        terminalModeStateRef.current.pendingTail = '';
        scanTerminalModes(terminalModeStateRef.current, plan.chunk);
      }
      persistModes();
      term.reset();
      resetInputTracking();
      const modeRestore = emitTerminalModeRestore(terminalModeStateRef.current);
      if (plan.chunk) {
        consumeOutputChunk(plan.chunk);
        consumeShellIntegration(plan.chunk);
        // 剥离历史中过期的 OSC 颜色 / CSI 设备查询，源头杜绝回放向 PTY 回报 rgb:... 应答
        const replayChunk = stripReplayTerminalQueries(plan.chunk);
        // write 回调 + 超时保险（见 beginSuspendInputForward）双通道释放
        writeProgressGuarded(withModeRestore(modeRestore, replayChunk), () => {
          releaseSuspend();
          calibrateAfterReplay(plan.chunk, wasInAlternateScreen);
        });
      } else {
        if (modeRestore) {
          try {
            term.write(modeRestore);
          } catch {
            // 忽略：模式恢复失败不影响后续输出
          }
        }
        releaseSuspend();
        calibrateAfterReplay(plan.chunk, wasInAlternateScreen);
      }
    } catch (error) {
      releaseSuspend();
      throw error;
    }
    setRenderedOutput(currentOutput);
  }, [
    beginSuspendInputForward,
    calibrateAfterReplay,
    consumeOutputChunk,
    consumeShellIntegration,
    endSuspendInputForward,
    feedModes,
    persistModes,
    renderedOutput,
    resetInputTracking,
    setRenderedOutput,
    sessionId,
    terminalOutput,
    writeProgressGuarded,
  ]);

  // 连接成功后聚焦终端，避免点到页面其它区域导致按键不进 xterm
  useEffect(() => {
    if (!liveConnectionId || !xtermRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      xtermRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [liveConnectionId, terminalInstanceVersion]);

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

  const castRecorderRef = useRef<CastRecorder | null>(null);
  const [isRecordingCast, setIsRecordingCast] = useState(false);
  const [castPlayerOpen, setCastPlayerOpen] = useState(false);
  const [recordedCastText, setRecordedCastText] = useState<string | null>(null);

  const handleToggleCastRecord = useCallback(() => {
    if (castRecorderRef.current) {
      const cast = castRecorderRef.current.exportCast();
      castRecorderRef.current = null;
      setIsRecordingCast(false);
      setRecordedCastText(cast);
      setCastPlayerOpen(true);
      return;
    }
    const term = xtermRef.current;
    castRecorderRef.current = createCastRecorder({
      width: term?.cols || 120,
      height: term?.rows || 32,
      title: activeSession?.title || sessionId || 'terminal',
    });
    setIsRecordingCast(true);
  }, [activeSession?.title, sessionId]);

  const handleMobileSequence = useCallback((seq: string) => {
    if (!liveConnectionId || !window.electronAPI) return;
    window.electronAPI.sshExecuteSync(liveConnectionId, seq);
    xtermRef.current?.focus();
  }, [liveConnectionId]);

  return (
    <div
      className="terminal-shell flex flex-col"
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
        canInsertAgentPrefix={hasSession}
        connectionId={liveConnectionId}
        onDecreaseFontSize={() => commitFontSize(fontSizeRef.current - 2)}
        onInsertAgentPrefix={handleOpenAgentDock}
        onIncreaseFontSize={() => commitFontSize(fontSizeRef.current + 2)}
        onToggleSearch={() => setShowSearch(prev => !prev)}
        onToggleThemeSelector={() => setShowThemeSelector(prev => !prev)}
        onCloseThemeSelector={() => setShowThemeSelector(false)}
        onSelectTheme={handleThemeChange}
        onSaveLog={handleSaveLog}
        isRecording={isRecordingCast}
        onToggleRecord={handleToggleCastRecord}
        onOpenCastPlayer={() => setCastPlayerOpen(true)}
      />

      {/* Search Bar */}
      {showSearch && (
        <div className="terminal-search-panel">
          <Search className="h-4 w-4 shrink-0 text-fg-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.shiftKey ? searchPrevious() : searchNext();
              } else if (e.key === 'Escape') {
                closeSearch();
              }
            }}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={searchPrevious}
            className="icon-button h-7 w-7 shrink-0"
            title={t('common.previous')}
            aria-label={t('common.previous')}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={searchNext}
            className="icon-button h-7 w-7 shrink-0"
            title={t('common.next')}
            aria-label={t('common.next')}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="icon-button h-7 w-7 shrink-0"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Terminal Container */}
      <div className={compact ? 'absolute inset-0 p-1' : 'absolute inset-0 p-2'}>
        <div
          ref={terminalRef}
          className="terminal-frame"
          onMouseDown={handleTerminalPointerDown}
          style={{
            cursor: 'text'
          }}
        />
      </div>

      {/* 终端顶部 AI 助手停靠卡片（向下展开，与终端 PTY 输出彻底分离） */}
      <TerminalAgentDock
        sessionId={sessionId}
        isAlternateScreen={isAlternateScreen}
        openToken={agentDockOpenToken}
        focusInputToken={agentDockFocusToken}
        collapseToken={agentDockCollapseToken}
        pastedDraft={agentDockPastedDraft}
        notice={agentDockNotice}
        onClearNotice={handleClearAgentNotice}
        isTaskInterrupted={isAgentTaskInterrupted}
        onInterruptTask={interruptAgentTask}
        onInsertCommand={handleInsertCommandToTerminal}
        onOpenSettings={onOpenAISettings}
        onFocusTerminal={handleFocusTerminal}
        translate={t}
      />

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
        vimSafeAvailable={Boolean(pastePreview?.vimSafe)}
        onVimSafePaste={handleVimSafePaste}
      />

      {/* No Connection State */}
      {terminalStatus && hasSession && hasTerminalOutput && (
        <div className={`terminal-state-banner terminal-state-banner-${terminalStatus.tone} ${showSearch ? '!top-14' : ''}`}>
          <span className="terminal-state-banner-icon">{terminalStatus.icon}</span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">{terminalStatus.title}</p>
            <p className="truncate text-[11px] opacity-80">{terminalStatus.body}</p>
          </div>
        </div>
      )}

      {terminalStatus && (!hasSession || !hasTerminalOutput) && (
        <div className={`terminal-state-overlay terminal-state-overlay-${terminalStatus.tone}`}>
          <div className="px-4 text-center">
            <div className="terminal-empty-icon">
              {terminalStatus.icon}
            </div>
            <p className="text-sm font-medium text-fg">{terminalStatus.title}</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-fg-muted">{terminalStatus.body}</p>
          </div>
        </div>
      )}
      <CastPlayerModal
        isOpen={castPlayerOpen}
        initialCast={recordedCastText}
        initialTitle={activeSession?.title}
        translate={t}
        onClose={() => setCastPlayerOpen(false)}
      />

      {zmodemPrompt && liveConnectionId && (
        <div className="absolute bottom-3 left-1/2 z-raised flex max-w-[92%] -translate-x-1/2 flex-wrap items-center gap-2 rounded-md border border-accent bg-surface px-3 py-2 text-xs shadow-lg">
          {zmodemPrompt.kind === 'rz' ? (
            <Upload className="h-3.5 w-3.5 shrink-0 text-accent" />
          ) : (
            <Download className="h-3.5 w-3.5 shrink-0 text-accent" />
          )}
          <span className="font-medium text-fg">
            {zmodemPrompt.kind === 'rz'
              ? t('terminal.zmodemRzDetected')
              : t('terminal.zmodemSzDetected', {
                files: zmodemPrompt.files.join(', ') || t('terminal.zmodemChooseInSftp'),
              })}
          </span>
          {zmodemPrompt.message && (
            <span className="text-[11px] text-fg-muted">{zmodemPrompt.message}</span>
          )}
          <button
            type="button"
            disabled={zmodemPrompt.busy}
            onClick={async () => {
              if (!window.electronAPI) return;
              setZmodemPrompt((prev) => (prev ? { ...prev, busy: true, message: undefined } : null));
              try {
                let remoteDir = activeSession?.cwd || DEFAULT_REMOTE_PATH;
                if (window.electronAPI.sshProbePwd) {
                  const probed = await window.electronAPI.sshProbePwd(liveConnectionId);
                  if (probed.success && probed.data?.cwd) remoteDir = probed.data.cwd;
                }
                if (zmodemPrompt.kind === 'rz') {
                  const pick = await window.electronAPI.selectSftpFiles();
                  if (!pick.success || pick.data.canceled || pick.data.files.length === 0) {
                    setZmodemPrompt(null);
                    return;
                  }
                  const res = await window.electronAPI.startSftpUpload({
                    connectionId: liveConnectionId,
                    files: pick.data.files,
                    remoteDirectory: remoteDir,
                  });
                  if (!res.success) {
                    setZmodemPrompt((prev) => (prev ? { ...prev, busy: false, message: res.error } : null));
                  } else {
                    setZmodemPrompt(null);
                  }
                } else {
                  if (zmodemPrompt.files.length === 0) {
                    setZmodemPrompt(null);
                    handleOpenFileTransfer();
                    return;
                  }
                  const dest = await window.electronAPI.selectSftpDownloadDestination();
                  if (!dest.success || dest.data.canceled || !dest.data.destination) {
                    setZmodemPrompt(null);
                    return;
                  }
                  const remotePaths = zmodemPrompt.files.map((file) => resolveRemotePath(remoteDir, file));
                  const res = await window.electronAPI.startSftpDownload({
                    connectionId: liveConnectionId,
                    remotePaths,
                    destination: dest.data.destination,
                  });
                  if (!res.success) {
                    setZmodemPrompt((prev) => (prev ? { ...prev, busy: false, message: res.error } : null));
                  } else {
                    setZmodemPrompt(null);
                  }
                }
              } finally {
                setZmodemPrompt((prev) => (prev ? { ...prev, busy: false } : null));
              }
            }}
            className="industrial-button-primary h-6 px-2 text-[11px]"
          >
            {zmodemPrompt.kind === 'rz' ? t('terminal.zmodemUploadNow') : t('terminal.zmodemDownloadNow')}
          </button>
          <button
            type="button"
            onClick={() => setZmodemPrompt(null)}
            className="icon-button h-6 w-6"
            aria-label={t('common.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="relative z-raised mt-auto">
        <MobileKeyBar
          mode={settings?.mobileKeyBarMode ?? 'auto'}
          disabled={!isLive}
          onSendSequence={handleMobileSequence}
        />
      </div>
    </div>
  );
}
