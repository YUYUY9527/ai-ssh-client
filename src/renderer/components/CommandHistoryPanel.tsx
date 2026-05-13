import { useState, useCallback, useRef, useEffect } from 'react';
import { Clock, RefreshCw, Search } from 'lucide-react';
import type { CommandHistoryItem } from '../../shared/types';

interface CommandHistoryPanelProps {
  onPasteCommand: (command: string) => void;
}

export function CommandHistoryPanel({ onPasteCommand }: CommandHistoryPanelProps) {
  const [show, setShow] = useState(false);
  const [historyList, setHistoryList] = useState<CommandHistoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!show) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShow(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [show]);

  const handleToggle = useCallback(async () => {
    if (show) {
      setShow(false);
      return;
    }
    if (window.electronAPI) {
      const result = await window.electronAPI.getCommandHistory();
      if (result.success) {
        setHistoryList(Array.isArray(result.data?.history) ? result.data.history : []);
      }
    }
    setSearchQuery('');
    setShow(true);
  }, [show]);

  const handlePaste = useCallback((command: string) => {
    onPasteCommand(command);
    setShow(false);
  }, [onPasteCommand]);

  const handleRerunInDir = useCallback((command: string, cwd: string) => {
    if ((window as any).writeToTerminal) {
      (window as any).writeToTerminal(`cd ${cwd} && ${command}\r`);
    }
    setShow(false);
  }, []);

  // 过滤列表
  const filtered = searchQuery
    ? historyList.filter(item =>
        item.command.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : historyList;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleToggle}
        className={`toolbar-button ${show ? 'toolbar-button-active' : ''}`}
        title="历史命令"
      >
        <Clock className="w-4 h-4" />
      </button>

      {show && (
        <div className="app-popover scrollbar-modern left-0 w-96">
          <div className="app-popover-header">
            <span>历史命令</span>
            <span className="text-[10px] font-normal normal-case tracking-normal opacity-60">
              点击粘贴 · 右侧按钮回到原目录执行
            </span>
          </div>

          {/* 搜索框 */}
          <div className="px-2 py-1.5 border-b border-[color-mix(in_srgb,var(--border-color)_60%,transparent)]">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-sm border border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_60%,transparent)]">
              <Search className="w-3 h-3 text-slate-400 flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索命令..."
                className="flex-1 bg-transparent text-xs text-slate-900 dark:text-white outline-none placeholder:text-slate-400"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="text-center text-slate-500 dark:text-slate-400 text-sm py-4">
                {searchQuery ? '无匹配结果' : '暂无历史命令'}
              </div>
            ) : (
              filtered.slice(0, 50).map((item) => (
                <div
                  key={item.id}
                  className="group flex items-center gap-1 mx-0.5 rounded-sm px-2 py-1.5 transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
                >
                  <button
                    onClick={() => handlePaste(item.command)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="font-mono text-xs text-slate-900 dark:text-white truncate">{item.command}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1">
                      <span>
                        {new Date(item.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {item.connectionName && <span>· {item.connectionName}</span>}
                      {item.cwd && <span className="text-teal-600 dark:text-teal-400">· {item.cwd}</span>}
                    </div>
                  </button>
                  {item.cwd && (
                    <button
                      onClick={() => handleRerunInDir(item.command, item.cwd!)}
                      className="hidden group-hover:flex flex-shrink-0 items-center justify-center h-6 w-6 rounded-sm border border-transparent hover:border-[color-mix(in_srgb,var(--accent-primary)_50%,var(--border-color))] hover:bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-slate-400 hover:text-teal-500 transition-colors"
                      title={`cd ${item.cwd} && ${item.command}`}
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
