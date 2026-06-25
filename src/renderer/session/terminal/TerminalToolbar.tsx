import { Search, ZoomIn, ZoomOut } from 'lucide-react';

interface TerminalToolbarProps {
  fontSize: number;
  isSearchOpen: boolean;
  terminalTheme: string;
  themeNames: Record<string, string>;
  themes: Record<string, { background?: string }>;
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
        title="缩小 (Ctrl+-)"
      >
        <ZoomOut className="w-4 h-4" />
      </button>
      <span className="terminal-toolbar-badge">{fontSize}px</span>
      <button
        onClick={onIncreaseFontSize}
        className="terminal-control"
        title="放大 (Ctrl++)"
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <button
        onClick={onToggleSearch}
        className={`terminal-control ${isSearchOpen ? 'terminal-control-active' : ''}`}
        title="搜索 (Ctrl+F)"
      >
        <Search className="w-4 h-4" />
      </button>

      <div className="relative">
        <button
          onClick={onToggleThemeSelector}
          className="terminal-control"
          title="切换主题"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
          </svg>
        </button>

        {isThemeSelectorOpen && (
          <div className="app-popover right-0 min-w-[160px] py-1">
            {Object.keys(themes).map((themeKey) => (
              <button
                key={themeKey}
                onClick={() => onSelectTheme(themeKey)}
                className={`app-popover-row text-sm ${
                  terminalTheme === themeKey
                    ? 'bg-teal-600 text-white'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-4 h-4 rounded-sm border border-slate-300 dark:border-slate-600"
                    style={{ background: themes[themeKey].background }}
                  />
                  {themeNames[themeKey]}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
