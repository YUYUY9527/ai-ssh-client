import { Download, Palette, Search, Settings2, ZoomIn, ZoomOut } from 'lucide-react';
import type { TerminalCursorStyle } from './terminal-settings';
import {
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
} from './terminal-settings';
import { IndustrialSelect } from '../../shared-ui/IndustrialSelect';

interface TerminalToolbarProps {
  fontSize: number;
  isSearchOpen: boolean;
  terminalTheme: string;
  themeNames: Record<string, string>;
  themes: Record<string, { background?: string }>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  isThemeSelectorOpen: boolean;
  isSettingsOpen: boolean;
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  shellIntegration: boolean;
  shellCwd: string | null;
  onDecreaseFontSize: () => void;
  onIncreaseFontSize: () => void;
  onToggleSearch: () => void;
  onToggleThemeSelector: () => void;
  onToggleSettings: () => void;
  onSelectTheme: (themeKey: string) => void;
  onScrollbackChange: (value: number) => void;
  onCursorStyleChange: (value: TerminalCursorStyle) => void;
  onCursorBlinkChange: (value: boolean) => void;
  onCopyOnSelectChange: (value: boolean) => void;
  onShellIntegrationChange: (value: boolean) => void;
  onSaveLog: () => void;
}

/** Terminal toolbar for font size, search, theme and professional settings. */
export function TerminalToolbar({
  fontSize,
  isSearchOpen,
  terminalTheme,
  themeNames,
  themes,
  translate,
  isThemeSelectorOpen,
  isSettingsOpen,
  scrollback,
  cursorStyle,
  cursorBlink,
  copyOnSelect,
  shellIntegration,
  shellCwd,
  onDecreaseFontSize,
  onIncreaseFontSize,
  onToggleSearch,
  onToggleThemeSelector,
  onToggleSettings,
  onSelectTheme,
  onScrollbackChange,
  onCursorStyleChange,
  onCursorBlinkChange,
  onCopyOnSelectChange,
  onShellIntegrationChange,
  onSaveLog,
}: TerminalToolbarProps) {
  return (
    <div className="terminal-toolbar">
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
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-4 h-4 rounded-sm border border-slate-300 dark:border-slate-600"
                    style={{ background: themes[themeKey].background }}
                  />
                  {themeNames[themeKey].startsWith('terminal.') ? translate(themeNames[themeKey]) : themeNames[themeKey]}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          onClick={onToggleSettings}
          className={`terminal-control ${isSettingsOpen ? 'terminal-control-active' : ''}`}
          title={translate('terminal.settings')}
          data-terminal-settings-toggle
        >
          <Settings2 className="w-4 h-4" />
        </button>

        {isSettingsOpen && (
          <div
            className="app-popover right-0 w-[280px] space-y-3 p-3"
            data-terminal-settings-panel
          >
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                {translate('terminal.scrollback')}
              </label>
              <input
                type="number"
                min={MIN_TERMINAL_SCROLLBACK}
                max={MAX_TERMINAL_SCROLLBACK}
                value={scrollback}
                onChange={(event) => onScrollbackChange(Number(event.target.value))}
                className="industrial-input w-full text-sm"
                data-terminal-setting="scrollback"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                {translate('terminal.cursorStyle')}
              </label>
              <IndustrialSelect
                value={cursorStyle}
                data-terminal-setting="cursorStyle"
                options={[
                  { value: 'block', label: translate('terminal.cursorBlock') },
                  { value: 'underline', label: translate('terminal.cursorUnderline') },
                  { value: 'bar', label: translate('terminal.cursorBar') },
                ]}
                onChange={(value) => onCursorStyleChange(value as TerminalCursorStyle)}
              />
            </div>

            <label className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>{translate('terminal.cursorBlink')}</span>
              <input
                type="checkbox"
                checked={cursorBlink}
                onChange={(event) => onCursorBlinkChange(event.target.checked)}
                data-terminal-setting="cursorBlink"
              />
            </label>

            <label className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>{translate('terminal.copyOnSelect')}</span>
              <input
                type="checkbox"
                checked={copyOnSelect}
                onChange={(event) => onCopyOnSelectChange(event.target.checked)}
                data-terminal-setting="copyOnSelect"
              />
            </label>

            <label className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>{translate('terminal.shellIntegration')}</span>
              <input
                type="checkbox"
                checked={shellIntegration}
                onChange={(event) => onShellIntegrationChange(event.target.checked)}
                data-terminal-setting="shellIntegration"
              />
            </label>

            {shellIntegration && shellCwd && (
              <div
                className="truncate rounded border border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] px-2 py-1 text-[11px] text-slate-500 dark:text-slate-400"
                title={shellCwd}
                data-terminal-shell-cwd
              >
                {translate('terminal.shellCwd')}: {shellCwd}
              </div>
            )}

            <button
              type="button"
              onClick={onSaveLog}
              className="industrial-button-secondary flex w-full items-center justify-center gap-2 text-sm"
              data-terminal-save-log
            >
              <Download className="h-4 w-4" />
              {translate('terminal.saveLog')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
