import { useEffect, useId, useRef, useState } from 'react';
import { Bot, Download, Palette, Search, SlidersHorizontal, X, ZoomIn, ZoomOut } from 'lucide-react';
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
  onSelectTheme: (themeKey: string) => void;
  onSaveLog: () => void;
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
  onSelectTheme,
  onSaveLog,
}: TerminalToolbarProps) {
  const [compactOpen, setCompactOpen] = useState(false);
  const toolbarContentId = useId();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!compactOpen) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target as Node)) {
        setCompactOpen(false);
      }
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
          title={translate('terminal.agentPrefixHint')}
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
        <button
          type="button"
          onClick={onSaveLog}
          className="terminal-control"
          title={translate('terminal.saveLog')}
          aria-label={translate('terminal.saveLog')}
          data-terminal-save-log
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onDecreaseFontSize}
          className="terminal-control"
          title={translate('terminal.zoomOut')}
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="terminal-toolbar-badge">{fontSize}px</span>
        <button
          type="button"
          onClick={onIncreaseFontSize}
          className="terminal-control"
          title={translate('terminal.zoomIn')}
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onToggleSearch}
          className={`terminal-control ${isSearchOpen ? 'terminal-control-active' : ''}`}
          title={translate('terminal.search')}
        >
          <Search className="w-4 h-4" />
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={onToggleThemeSelector}
            className="terminal-control"
            title={translate('terminal.changeTheme')}
          >
            <Palette className="w-4 h-4" />
          </button>

          {isThemeSelectorOpen && (
            <div className="app-popover right-0 min-w-[160px] py-1">
              {Object.keys(themes).map((themeKey) => (
                <button
                  key={themeKey}
                  onClick={() => onSelectTheme(themeKey)}
                  className={`app-popover-row text-sm ${
                    terminalTheme === themeKey
                      ? 'bg-[color-mix(in_srgb,var(--accent-primary)_85%,transparent)] text-white'
                      : 'text-fg-secondary'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 rounded-sm border border-line-subtle dark:border-line"
                      style={{ background: themes[themeKey].background }}
                    />
                    {themeNames[themeKey].startsWith('terminal.') ? translate(themeNames[themeKey]) : themeNames[themeKey]}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
