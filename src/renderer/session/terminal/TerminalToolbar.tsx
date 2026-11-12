import { Bot, Download, Palette, Search, ZoomIn, ZoomOut } from 'lucide-react';
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
  return (
    <div className="terminal-toolbar">
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
        onClick={onDecreaseFontSize}
        className="terminal-control"
        title={translate('terminal.zoomOut')}
      >
        <ZoomOut className="w-4 h-4" />
      </button>
      <span className="terminal-toolbar-badge">{fontSize}px</span>
      <button
        onClick={onIncreaseFontSize}
        className="terminal-control"
        title={translate('terminal.zoomIn')}
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <button
        onClick={onToggleSearch}
        className={`terminal-control ${isSearchOpen ? 'terminal-control-active' : ''}`}
        title={translate('terminal.search')}
      >
        <Search className="w-4 h-4" />
      </button>

      <div className="relative">
        <button
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
  );
}
