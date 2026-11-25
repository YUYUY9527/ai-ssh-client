import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronRight,
  Copy,
  CornerDownLeft,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useI18n } from '../i18n';
import type { QuickCommand, QuickCommandGroup } from '../../shared/types';

/** 与分组列表色点统一的预设色板（避免系统原生 color picker 样式割裂） */
const GROUP_COLOR_PALETTE = [
  '#14b8a6', // teal (accent)
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#64748b', // slate
  '#ef4444', // red
] as const;

const DEFAULT_GROUP_COLOR: string = GROUP_COLOR_PALETTE[0];

interface QuickCommandsPanelProps {
  onPasteCommand: (command: string) => void;
}

/** 分组色点：新建表单与列表共用同一视觉规格 */
function GroupColorSwatch({
  color,
  selected = false,
  size = 'md',
  onClick,
  title,
  empty = false,
}: {
  color: string;
  selected?: boolean;
  size?: 'sm' | 'md';
  onClick?: () => void;
  title?: string;
  /** 无分组：空心圆 */
  empty?: boolean;
}) {
  const dim = size === 'sm' ? 'h-2.5 w-2.5' : 'h-6 w-6';
  const ring = selected
    ? 'ring-2 ring-[var(--accent-primary)] ring-offset-1 ring-offset-[var(--bg-secondary)]'
    : 'ring-1 ring-[color-mix(in_srgb,var(--border-color)_70%,transparent)]';
  const emptyClass = empty
    ? 'border border-dashed border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-transparent'
    : '';

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        aria-pressed={selected}
        className={`${dim} shrink-0 rounded-full transition-transform hover:scale-110 ${ring} ${emptyClass}`}
        style={empty ? undefined : { backgroundColor: color }}
      />
    );
  }

  return (
    <span
      className={`${dim} shrink-0 rounded-full ${ring} ${emptyClass}`}
      style={empty ? undefined : { backgroundColor: color }}
      title={title}
      aria-hidden
    />
  );
}

export function QuickCommandsPanel({ onPasteCommand }: QuickCommandsPanelProps) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [groups, setGroups] = useState<QuickCommandGroup[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingCommand, setEditingCommand] = useState<QuickCommand | null>(null);
  const [newCommand, setNewCommand] = useState({ name: '', command: '', description: '', groupId: '' });
  const [newGroup, setNewGroup] = useState({ name: '', color: DEFAULT_GROUP_COLOR });
  const [showCommandForm, setShowCommandForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 点击外部 / Esc 关闭（使用 mousedown，避免取消/删除卸载按钮后误触发关闭）
  useEffect(() => {
    if (!show) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setShow(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showCommandForm || showGroupForm) {
          setShowCommandForm(false);
          setShowGroupForm(false);
          setEditingCommand(null);
          return;
        }
        setShow(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [show, showCommandForm, showGroupForm]);

  useEffect(() => {
    if (!show) {
      setSearchQuery('');
      setCopiedId(null);
    }
  }, [show]);

  useEffect(() => () => {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (!show) {
      setPopoverPos(null);
      return;
    }
    const updatePosition = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(368, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      const top = rect.bottom + 8;
      setPopoverPos({ left, top, width });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [show]);

  const loadData = useCallback(async () => {
    if (!window.electronAPI) return;
    const [commandsResult, groupsResult] = await Promise.all([
      window.electronAPI.getQuickCommands(),
      window.electronAPI.getQuickCommandGroups(),
    ]);
    if (commandsResult.success) {
      setCommands(Array.isArray(commandsResult.data?.commands) ? commandsResult.data.commands : []);
    }
    if (groupsResult.success) {
      setGroups(Array.isArray(groupsResult.data?.groups) ? groupsResult.data.groups : []);
    }
  }, []);

  // 初始加载
  useEffect(() => { loadData(); }, [loadData]);

  const handlePaste = useCallback((cmd: string) => {
    onPasteCommand(cmd);
    setShow(false);
  }, [onPasteCommand]);

  const handleCopy = useCallback(async (cmd: QuickCommand) => {
    try {
      await navigator.clipboard.writeText(cmd.command);
      setCopiedId(cmd.id);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopiedId((current) => (current === cmd.id ? null : current));
      }, 1500);
    } catch {
      // 浏览器可能限制剪贴板权限，忽略即可
    }
  }, []);

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const resetCommandForm = () => {
    setShowCommandForm(false);
    setEditingCommand(null);
    setNewCommand({ name: '', command: '', description: '', groupId: '' });
  };

  const handleSaveCommand = async () => {
    if (!newCommand.name.trim() || !newCommand.command.trim()) return;
    const cmd: QuickCommand = {
      id: editingCommand?.id || Date.now().toString(),
      name: newCommand.name.trim(),
      command: newCommand.command,
      description: newCommand.description.trim(),
      groupId: newCommand.groupId || undefined,
    };
    if (window.electronAPI) {
      await window.electronAPI.saveQuickCommand(cmd);
      await loadData();
    }
    resetCommandForm();
  };

  const handleDeleteCommand = async (commandId: string) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteQuickCommand(commandId);
      await loadData();
    }
  };

  const handleSaveGroup = async () => {
    if (!newGroup.name.trim()) return;
    const group: QuickCommandGroup = {
      id: Date.now().toString(),
      name: newGroup.name.trim(),
      color: newGroup.color,
    };
    if (window.electronAPI) {
      await window.electronAPI.saveQuickCommandGroup(group);
      await loadData();
    }
    setNewGroup({ name: '', color: DEFAULT_GROUP_COLOR });
    setShowGroupForm(false);
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteQuickCommandGroup(groupId);
      await loadData();
    }
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredCommands = useMemo(() => {
    if (!normalizedQuery) return commands;
    return commands.filter((item) =>
      `${item.name} ${item.command} ${item.description || ''}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [commands, normalizedQuery]);

  const ungroupedCommands = filteredCommands.filter((c) => !c.groupId);
  const showSearch = commands.length > 3 && !showCommandForm && !showGroupForm;

  const openEditCommand = (c: QuickCommand) => {
    setEditingCommand(c);
    setNewCommand({
      name: c.name,
      command: c.command,
      description: c.description || '',
      groupId: c.groupId || '',
    });
    setShowCommandForm(true);
    setShowGroupForm(false);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setShow(!show)}
        className={`toolbar-button whitespace-nowrap ${show ? 'toolbar-button-active' : ''}`}
        title={t('quickCommands.title')}
        aria-label={t('quickCommands.title')}
        aria-expanded={show}
      >
        <Zap className="h-4 w-4 shrink-0" />
        <span className="hidden md:inline">{t('quickCommands.commands')}</span>
      </button>

      {show && popoverPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="app-popover header-popover fixed top-auto z-overlay mt-0 max-h-[min(32rem,calc(100vh-5rem))]"
          style={{
            left: popoverPos.left,
            top: popoverPos.top,
            width: popoverPos.width,
          }}
        >
          {/* 头部 */}
          <div className="header-popover-header">
            <div className="header-popover-title-wrap">
              <span className="header-popover-icon">
                <Zap className="h-3.5 w-3.5" />
              </span>
              <span className="header-popover-title">{t('quickCommands.title')}</span>
              <span className="header-popover-count">{commands.length}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setShowGroupForm((open) => !open);
                  setShowCommandForm(false);
                  setEditingCommand(null);
                }}
                className={`icon-button h-7 w-7 ${showGroupForm ? 'icon-button-active' : ''}`}
                title={t('quickCommands.newGroup')}
                aria-label={t('quickCommands.newGroup')}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (showCommandForm && !editingCommand) {
                    resetCommandForm();
                  } else {
                    setEditingCommand(null);
                    setNewCommand({ name: '', command: '', description: '', groupId: '' });
                    setShowCommandForm(true);
                    setShowGroupForm(false);
                  }
                }}
                className={`icon-button h-7 w-7 ${showCommandForm && !editingCommand ? 'icon-button-active' : ''}`}
                title={t('quickCommands.newCommand')}
                aria-label={t('quickCommands.newCommand')}
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* 搜索栏 */}
          {showSearch && (
            <div className="header-popover-search-bar">
              <div className="header-popover-search">
                <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('quickCommands.searchPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
                  autoFocus
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="icon-button h-5 w-5 shrink-0"
                    title={t('common.close')}
                    aria-label={t('common.close')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                <span className="header-popover-count">{filteredCommands.length}</span>
              </div>
            </div>
          )}

          <div className="scrollbar-modern min-h-0 flex-1 overflow-y-auto">
            {/* 新建分组表单 */}
            {showGroupForm && (
              <div className="header-popover-form">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                    <FolderPlus className="h-3.5 w-3.5 text-accent" />
                    {t('quickCommands.newGroup')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowGroupForm(false)}
                    className="icon-button h-6 w-6"
                    title={t('common.close')}
                    aria-label={t('common.close')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="industrial-field-label">{t('quickCommands.groupName')}</label>
                    <input
                      type="text"
                      value={newGroup.name}
                      onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newGroup.name.trim()) {
                          void handleSaveGroup();
                        }
                      }}
                      placeholder={t('quickCommands.groupName')}
                      className="industrial-input w-full py-1.5"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="industrial-field-label">{t('quickCommands.groupColor')}</label>
                    <div className="industrial-card flex flex-wrap items-center gap-2 p-2.5">
                      {GROUP_COLOR_PALETTE.map((color) => (
                        <GroupColorSwatch
                          key={color}
                          color={color}
                          size="md"
                          selected={newGroup.color.toLowerCase() === color.toLowerCase()}
                          title={color}
                          onClick={() => setNewGroup({ ...newGroup, color })}
                        />
                      ))}
                      <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
                        <GroupColorSwatch color={newGroup.color} size="sm" />
                        {newGroup.color.toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={!newGroup.name.trim()}
                      onClick={() => void handleSaveGroup()}
                      className="industrial-button-primary flex-1 px-2 py-1.5 text-xs"
                    >
                      {t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowGroupForm(false)}
                      className="industrial-button-secondary flex-1 px-2 py-1.5 text-xs"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 新建 / 编辑命令表单 */}
            {showCommandForm && (
              <div className="header-popover-form">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                    {editingCommand ? (
                      <Pencil className="h-3.5 w-3.5 text-accent" />
                    ) : (
                      <Plus className="h-3.5 w-3.5 text-accent" />
                    )}
                    {editingCommand ? t('quickCommands.editCommand') : t('quickCommands.newCommand')}
                  </span>
                  <button
                    type="button"
                    onClick={resetCommandForm}
                    className="icon-button h-6 w-6"
                    title={t('common.close')}
                    aria-label={t('common.close')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="space-y-2.5">
                  <div>
                    <label className="industrial-field-label">{t('quickCommands.commandName')}</label>
                    <input
                      type="text"
                      value={newCommand.name}
                      onChange={(e) => setNewCommand({ ...newCommand, name: e.target.value })}
                      placeholder={t('quickCommands.commandName')}
                      className="industrial-input w-full py-1.5"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="industrial-field-label">{t('quickCommands.commandContent')}</label>
                    <input
                      type="text"
                      value={newCommand.command}
                      onChange={(e) => setNewCommand({ ...newCommand, command: e.target.value })}
                      placeholder={t('quickCommands.commandContent')}
                      className="industrial-input w-full py-1.5 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="industrial-field-label">{t('quickCommands.description')}</label>
                    <input
                      type="text"
                      value={newCommand.description}
                      onChange={(e) => setNewCommand({ ...newCommand, description: e.target.value })}
                      placeholder={t('quickCommands.description')}
                      className="industrial-input w-full py-1.5"
                    />
                  </div>
                  {groups.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="industrial-field-label mb-0">{t('quickCommands.group')}</label>
                      {/* 自定义分组选择：色点 + 名称，与列表样式一致 */}
                      <div className="industrial-card max-h-36 space-y-0.5 overflow-y-auto p-1 scrollbar-thin">
                        <button
                          type="button"
                          onClick={() => setNewCommand({ ...newCommand, groupId: '' })}
                          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors ${
                            !newCommand.groupId
                              ? 'bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] font-medium text-fg'
                              : 'text-fg-secondary hover:bg-[color-mix(in_srgb,var(--bg-hover)_70%,transparent)]'
                          }`}
                        >
                          <GroupColorSwatch color="transparent" size="sm" empty />
                          <span className="truncate">{t('quickCommands.noGroup')}</span>
                        </button>
                        {groups.map((group) => (
                          <button
                            key={group.id}
                            type="button"
                            onClick={() => setNewCommand({ ...newCommand, groupId: group.id })}
                            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors ${
                              newCommand.groupId === group.id
                                ? 'bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] font-medium text-fg'
                                : 'text-fg-secondary hover:bg-[color-mix(in_srgb,var(--bg-hover)_70%,transparent)]'
                            }`}
                          >
                            <GroupColorSwatch color={group.color || DEFAULT_GROUP_COLOR} size="sm" />
                            <span className="truncate">{group.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-1.5 pt-0.5">
                    <button
                      type="button"
                      disabled={!newCommand.name.trim() || !newCommand.command.trim()}
                      onClick={() => void handleSaveCommand()}
                      className="industrial-button-primary flex-1 px-2 py-1.5 text-xs"
                    >
                      {t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={resetCommandForm}
                      className="industrial-button-secondary flex-1 px-2 py-1.5 text-xs"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 命令列表 */}
            <div className="p-2">
              {commands.length === 0 && groups.length === 0 && !showCommandForm && !showGroupForm ? (
                <div className="header-popover-empty">
                  <span className="header-popover-empty-icon">
                    <Zap className="h-4 w-4" />
                  </span>
                  <p className="text-xs text-fg-muted">{t('quickCommands.noCommands')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCommandForm(true);
                      setShowGroupForm(false);
                    }}
                    className="industrial-button-primary mt-1 px-3 py-1.5 text-xs"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('quickCommands.newCommand')}
                  </button>
                </div>
              ) : normalizedQuery && filteredCommands.length === 0 ? (
                <div className="header-popover-empty">
                  <span className="header-popover-empty-icon">
                    <Search className="h-4 w-4" />
                  </span>
                  <p className="text-xs text-fg-muted">{t('quickCommands.noMatches')}</p>
                </div>
              ) : (
                <>
                  {groups.map((group) => {
                    const groupCmds = filteredCommands.filter((c) => c.groupId === group.id);
                    if (normalizedQuery && groupCmds.length === 0) {
                      return null;
                    }
                    const groupColor = group.color || DEFAULT_GROUP_COLOR;
                    const collapsed = !normalizedQuery && collapsedGroups.has(group.id);
                    return (
                      <div key={group.id} className="mb-2.5 last:mb-0">
                        <div className="header-popover-section group mb-1 justify-between">
                          <button
                            type="button"
                            onClick={() => toggleGroupCollapsed(group.id)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            <ChevronRight
                              className={`h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
                            />
                            <GroupColorSwatch color={groupColor} size="sm" title={groupColor} />
                            <span className="truncate text-xs font-semibold text-fg-secondary" title={group.name}>
                              {group.name}
                            </span>
                            <span className="header-popover-count">{groupCmds.length}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteGroup(group.id)}
                            className="icon-button h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-danger"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                        {!collapsed && (
                          <div className="ml-2.5 space-y-1 border-l border-line-subtle pl-2">
                            {groupCmds.length === 0 ? (
                              <p className="px-2 py-1.5 text-[11px] text-fg-subtle">{t('quickCommands.emptyGroup')}</p>
                            ) : (
                              groupCmds.map((cmd) => (
                                <CommandItem
                                  key={cmd.id}
                                  cmd={cmd}
                                  copied={copiedId === cmd.id}
                                  copyLabel={t('common.copy')}
                                  copiedLabel={t('quickCommands.copied')}
                                  editLabel={t('common.edit')}
                                  deleteLabel={t('common.delete')}
                                  onPaste={handlePaste}
                                  onCopy={handleCopy}
                                  onEdit={openEditCommand}
                                  onDelete={handleDeleteCommand}
                                />
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {ungroupedCommands.length > 0 && (
                    <div>
                      {groups.length > 0 && (
                        <div className="header-popover-section mb-1">
                          <GroupColorSwatch color="transparent" size="sm" empty />
                          <span className="truncate text-xs font-semibold text-fg-muted">
                            {t('quickCommands.noGroup')}
                          </span>
                          <span className="header-popover-count">{ungroupedCommands.length}</span>
                        </div>
                      )}
                      <div className={groups.length > 0 ? 'ml-2.5 space-y-1 border-l border-line-subtle pl-2' : 'space-y-1'}>
                        {ungroupedCommands.map((cmd) => (
                          <CommandItem
                            key={cmd.id}
                            cmd={cmd}
                            copied={copiedId === cmd.id}
                            copyLabel={t('common.copy')}
                            copiedLabel={t('quickCommands.copied')}
                            editLabel={t('common.edit')}
                            deleteLabel={t('common.delete')}
                            onPaste={handlePaste}
                            onCopy={handleCopy}
                            onEdit={openEditCommand}
                            onDelete={handleDeleteCommand}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {commands.length > 0 && !showCommandForm && !showGroupForm && (
            <div className="header-popover-footer text-[11px] text-fg-subtle">
              <span className="flex items-center gap-1.5">
                <CornerDownLeft className="h-3 w-3 text-accent" />
                {t('quickCommands.clickToPaste')}
              </span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function CommandItem({
  cmd,
  copied,
  copyLabel,
  copiedLabel,
  editLabel,
  deleteLabel,
  onPaste,
  onCopy,
  onEdit,
  onDelete,
}: {
  cmd: QuickCommand;
  copied: boolean;
  copyLabel: string;
  copiedLabel: string;
  editLabel: string;
  deleteLabel: string;
  onPaste: (command: string) => void;
  onCopy: (cmd: QuickCommand) => void;
  onEdit: (cmd: QuickCommand) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="header-popover-item group flex-col items-stretch gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onPaste(cmd.command)}
          className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-fg"
          title={cmd.description ? `${cmd.name} — ${cmd.description}\n${cmd.command}` : `${cmd.name}\n${cmd.command}`}
        >
          {cmd.name}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(cmd);
            }}
            className="icon-button h-6 w-6"
            title={copied ? copiedLabel : copyLabel}
            aria-label={copied ? copiedLabel : copyLabel}
          >
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(cmd);
            }}
            className="icon-button h-6 w-6"
            title={editLabel}
            aria-label={editLabel}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(cmd.id);
            }}
            className="icon-button h-6 w-6 hover:text-danger"
            title={deleteLabel}
            aria-label={deleteLabel}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onPaste(cmd.command)}
        className="header-popover-code w-full text-left transition-colors group-hover:border-line"
        title={cmd.command}
      >
        <span className="shrink-0 select-none text-accent">$</span>
        <span className="min-w-0 flex-1 truncate">{cmd.command}</span>
        <CornerDownLeft className="h-3 w-3 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      {cmd.description && (
        <p className="truncate px-0.5 text-[11px] text-fg-subtle" title={cmd.description}>
          {cmd.description}
        </p>
      )}
    </div>
  );
}
