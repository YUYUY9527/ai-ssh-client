import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Circle, Download, Film, MoreVertical, Palette, Search, SlidersHorizontal, Square, X, ZoomIn, ZoomOut } from 'lucide-react';
import { ServerMonitorButton } from './ServerMonitorButton';
import { PortForwardButton } from './PortForwardButton';
import { BroadcastButton } from './BroadcastButton';
import { DockerButton } from './DockerButton';

interface TerminalToolbarProps {
  fontSize: number;
  isSearchOpen: boolean;
  terminalTheme: string;
  themeNames: Record<string, string>;
  themes: Record<string, { background?: string }>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  isThemeSelectorOpen: boolean;
  canInsertAgentPrefix: boolean;
  /** 活动 SSH 连接 id，供服务器监控按钮采集指标；无连接时监控按钮隐藏。 */
  connectionId: string | null;
  onDecreaseFontSize: () => void;
  onInsertAgentPrefix: () => void;
  onIncreaseFontSize: () => void;
  onToggleSearch: () => void;
  onToggleThemeSelector: () => void;
  onCloseThemeSelector?: () => void;
  onSelectTheme: (themeKey: string) => void;
  onSaveLog: () => void;
  isRecording?: boolean;
  onToggleRecord?: () => void;
  onOpenCastPlayer?: () => void;
}

/** Terminal toolbar for font size, search and theme. */
export function TerminalToolbar({
  fontSize,
  isSearchOpen,
  terminalTheme,
  themeNames,
  themes,
  translate,
  isThemeSelectorOpen,
  canInsertAgentPrefix,
  connectionId,
  onDecreaseFontSize,
  onInsertAgentPrefix,
  onIncreaseFontSize,
  onToggleSearch,
  onToggleThemeSelector,
  onCloseThemeSelector,
  onSelectTheme,
  onSaveLog,
  isRecording = false,
  onToggleRecord,
  onOpenCastPlayer,
}: TerminalToolbarProps) {
  const [compactOpen, setCompactOpen] = useState(false);
  const [themeMenuPos, setThemeMenuPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionMenuPos, setSessionMenuPos] = useState<{ top: number; left: number } | null>(null);
  const toolbarContentId = useId();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const themeTriggerRef = useRef<HTMLButtonElement>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const sessionTriggerRef = useRef<HTMLButtonElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  const closeThemeMenu = () => {
    if (!isThemeSelectorOpen) return;
    if (onCloseThemeSelector) {
      onCloseThemeSelector();
    } else {
      onToggleThemeSelector();
    }
  };

  useEffect(() => {
    if (!compactOpen) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const clickedToolbar = toolbarRef.current?.contains(target as Node);
      const clickedToolbarPopup = target instanceof Element && target.closest('[data-terminal-toolbar-popup]');
      if (!clickedToolbar && !clickedToolbarPopup) setCompactOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCompactOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [compactOpen]);

  // 主题选择器通过 Portal 挂载到 body，避免被窄分屏折叠工具栏或终端容器裁切
  useLayoutEffect(() => {
    if (!isThemeSelectorOpen) {
      setThemeMenuPos(null);
      return;
    }
    const updatePosition = () => {
      const btn = themeTriggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const menuWidth = 176;
      const margin = 8;
      const left = Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin));
      const spaceBelow = window.innerHeight - rect.bottom - margin - 6;
      const spaceAbove = rect.top - margin - 6;
      const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(140, Math.min(340, openUp ? spaceAbove : spaceBelow));
      const top = openUp
        ? Math.max(margin, rect.top - 6 - maxHeight)
        : rect.bottom + 6;
      setThemeMenuPos({ top, left, maxHeight });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isThemeSelectorOpen]);

  useEffect(() => {
    if (!isThemeSelectorOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (themeTriggerRef.current?.contains(target) || themeMenuRef.current?.contains(target)) {
        return;
      }
      closeThemeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeThemeMenu();
        themeTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isThemeSelectorOpen]);

  // 会话操作列表同样通过 Portal 挂载到 body，避免被终端容器或窄分屏裁切
  useLayoutEffect(() => {
    if (!sessionMenuOpen) {
      setSessionMenuPos(null);
      return;
    }
    const updatePosition = () => {
      const btn = sessionTriggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const menuWidth = 184;
      const margin = 8;
      const left = Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin));
      const spaceBelow = window.innerHeight - rect.bottom - margin - 6;
      const openUp = spaceBelow < 140 && rect.top > spaceBelow;
      const top = openUp ? Math.max(margin, rect.top - 6 - 124) : rect.bottom + 6;
      setSessionMenuPos({ top, left });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (sessionTriggerRef.current?.contains(target) || sessionMenuRef.current?.contains(target)) {
        return;
      }
      setSessionMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setSessionMenuOpen(false);
        sessionTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [sessionMenuOpen]);

  return (
    <div ref={toolbarRef} className={`terminal-toolbar ${compactOpen ? 'is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="terminal-toolbar-trigger terminal-control"
        title={translate('terminal.toolbar')}
        aria-label={translate('terminal.toolbar')}
        aria-expanded={compactOpen}
        aria-controls={toolbarContentId}
        onClick={() => setCompactOpen((open) => !open)}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      {compactOpen && (
        <div className="terminal-toolbar-menu-head">
          <span>{translate('terminal.toolbar')}</span>
          <button
            type="button"
            className="icon-button h-7 w-7"
            title={translate('common.close')}
            aria-label={translate('common.close')}
            onClick={() => setCompactOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div id={toolbarContentId} className="terminal-toolbar-content">
        <button
          type="button"
          onClick={onInsertAgentPrefix}
          disabled={!canInsertAgentPrefix}
          className="terminal-agent-prefix-hint"
          aria-label={translate('terminal.agentInsertPrefix')}
          data-tooltip={translate('terminal.agentPrefixGuide')}
        >
          <Bot className="h-4 w-4" />
          <span className="terminal-agent-prefix-tooltip" role="tooltip">
            {translate('terminal.agentPrefixGuide')}
          </span>
        </button>
        <ServerMonitorButton connectionId={connectionId} translate={translate} />
        <PortForwardButton connectionId={connectionId} translate={translate} />
        <BroadcastButton translate={translate} />
        <DockerButton connectionId={connectionId} translate={translate} />
        <span className="terminal-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          onClick={onDecreaseFontSize}
          className="terminal-control"
          title={translate('terminal.zoomOut')}
          aria-label={translate('terminal.zoomOut')}
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="terminal-toolbar-badge">{fontSize}px</span>
        <button
          type="button"
          onClick={onIncreaseFontSize}
          className="terminal-control"
          title={translate('terminal.zoomIn')}
          aria-label={translate('terminal.zoomIn')}
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <span className="terminal-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          onClick={onToggleSearch}
          className={`terminal-control ${isSearchOpen ? 'terminal-control-active' : ''}`}
          title={translate('terminal.search')}
          aria-label={translate('terminal.search')}
          aria-pressed={isSearchOpen}
        >
          <Search className="h-4 w-4" />
        </button>

        <div className="relative">
          <button
            ref={themeTriggerRef}
            type="button"
            onClick={() => {
              setSessionMenuOpen(false);
              onToggleThemeSelector();
            }}
            className={`terminal-control ${isThemeSelectorOpen ? 'terminal-control-active' : ''}`}
            title={translate('terminal.changeTheme')}
            aria-label={translate('terminal.changeTheme')}
            aria-expanded={isThemeSelectorOpen}
          >
            <Palette className="h-4 w-4" />
          </button>

          {isThemeSelectorOpen && themeMenuPos && typeof document !== 'undefined' && createPortal(
            <div
              ref={themeMenuRef}
              data-terminal-toolbar-popup="true"
              className="app-popover fixed top-auto z-overlay mt-0 w-[176px] py-1 scrollbar-thin"
              style={{
                top: themeMenuPos.top,
                left: themeMenuPos.left,
                maxHeight: themeMenuPos.maxHeight,
              }}
            >
              {Object.keys(themes).map((themeKey) => (
                <button
                  key={themeKey}
                  type="button"
                  onClick={() => onSelectTheme(themeKey)}
                  className={`app-popover-row text-sm ${
                    terminalTheme === themeKey
                      ? 'bg-[color-mix(in_srgb,var(--accent-primary)_85%,transparent)] text-white'
                      : 'text-fg-secondary'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div
                      className="h-4 w-4 shrink-0 rounded-sm border border-line-subtle dark:border-line"
                      style={{ background: themes[themeKey].background }}
                    />
                    <span className="truncate">
                      {themeNames[themeKey].startsWith('terminal.') ? translate(themeNames[themeKey]) : themeNames[themeKey]}
                    </span>
                  </div>
                </button>
              ))}
            </div>,
            document.body,
          )}
        </div>

        <div className="relative">
          <button
            ref={sessionTriggerRef}
            type="button"
            onClick={() => {
              closeThemeMenu();
              setSessionMenuOpen((open) => !open);
            }}
            className={`terminal-control relative ${sessionMenuOpen || isRecording ? 'terminal-control-active' : ''}`}
            title={translate('terminal.sessionActions')}
            aria-label={translate('terminal.sessionActions')}
            aria-haspopup="menu"
            aria-expanded={sessionMenuOpen}
            data-terminal-session-menu-trigger
          >
            <MoreVertical className="h-4 w-4" />
            {isRecording && (
              <span
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger animate-pulse"
                aria-hidden="true"
              />
            )}
          </button>

          {sessionMenuOpen && sessionMenuPos && typeof document !== 'undefined' && createPortal(
            <div
              ref={sessionMenuRef}
              role="menu"
              data-terminal-toolbar-popup="true"
              className="app-popover fixed top-auto z-overlay mt-0 w-[184px] py-1"
              style={{
                top: sessionMenuPos.top,
                left: sessionMenuPos.left,
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSessionMenuOpen(false);
                  onSaveLog();
                }}
                className="app-popover-row text-xs text-fg-secondary"
                data-terminal-save-log
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Download className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                  <span className="truncate">{translate('terminal.saveLog')}</span>
                </span>
              </button>
              {onToggleRecord && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSessionMenuOpen(false);
                    onToggleRecord();
                  }}
                  className={`app-popover-row text-xs ${isRecording ? 'text-danger-fg' : 'text-fg-secondary'}`}
                  data-terminal-toggle-record
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {isRecording
                      ? <Square className="h-3.5 w-3.5 shrink-0 fill-current text-danger" />
                      : <Circle className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
                    <span className="truncate">
                      {isRecording ? translate('features.recorder.stopRecord') : translate('features.recorder.startRecord')}
                    </span>
                  </span>
                </button>
              )}
              {onOpenCastPlayer && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSessionMenuOpen(false);
                    onOpenCastPlayer();
                  }}
                  className="app-popover-row text-xs text-fg-secondary"
                  data-terminal-cast-player
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Film className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{translate('features.recorder.playerTitle')}</span>
                  </span>
                </button>
              )}
            </div>,
            document.body,
          )}
        </div>
      </div>
    </div>
  );
}
