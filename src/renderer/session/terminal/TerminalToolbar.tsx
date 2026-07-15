import { Palette, Search, ZoomIn, ZoomOut } from 'lucide-react';

interface TerminalToolbarProps {
  fontSize: number;
  isSearchOpen: boolean;
  terminalTheme: string;
  themeNames: Record<string, string>;
  themes: Record<string, { background?: string }>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  isThemeSelectorOpen: boolean;
  onDecreaseFontSize: () => void;
  onIncreaseFontSize: () => void;
  onToggleSearch: () => void;
  onToggleThemeSelector: () => void;
  onSelectTheme: (themeKey: string) => void;
}

/** Terminal toolbar for font size, search and theme controls. */
export function TerminalToolbar({
  fontSize,
  isSearchOpen,
  terminalTheme,
  themeNames,
  themes,
  translate,
  isThemeSelectorOpen,
  onDecreaseFontSize,
  onIncreaseFontSize,
  onToggleSearch,
  onToggleThemeSelector,
  onSelectTheme,
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
    </div>
  );
}
