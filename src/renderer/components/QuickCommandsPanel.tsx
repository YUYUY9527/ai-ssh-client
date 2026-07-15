import { useState, useEffect, useRef, useCallback } from 'react';
import { Zap, ChevronDown, FolderUp, Plus, Trash2, Pencil } from 'lucide-react';
import { t } from '../i18n';
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
  const dim = size === 'sm' ? 'h-3 w-3' : 'h-6 w-6';
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
  const [show, setShow] = useState(false);
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [groups, setGroups] = useState<QuickCommandGroup[]>([]);
  const [editingCommand, setEditingCommand] = useState<QuickCommand | null>(null);
  const [newCommand, setNewCommand] = useState({ name: '', command: '', description: '', groupId: '' });
  const [newGroup, setNewGroup] = useState({ name: '', color: DEFAULT_GROUP_COLOR });
  const [showCommandForm, setShowCommandForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
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

  const handleSaveCommand = async () => {
    if (!newCommand.name || !newCommand.command) return;
    const cmd: QuickCommand = {
      id: editingCommand?.id || Date.now().toString(),
      name: newCommand.name,
      command: newCommand.command,
      description: newCommand.description,
      groupId: newCommand.groupId || undefined,
    };
    if (window.electronAPI) {
      await window.electronAPI.saveQuickCommand(cmd);
      await loadData();
    }
    setNewCommand({ name: '', command: '', description: '', groupId: '' });
    setEditingCommand(null);
    setShowCommandForm(false);
  };

  const handleDeleteCommand = async (commandId: string) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteQuickCommand(commandId);
      await loadData();
    }
  };

  const handleSaveGroup = async () => {
    if (!newGroup.name) return;
    const group: QuickCommandGroup = {
      id: Date.now().toString(),
      name: newGroup.name,
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

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setShow(!show)}
        className={`toolbar-button ${show ? 'toolbar-button-active' : ''}`}
        title={t('quickCommands.title')}
      >
        <Zap className="w-4 h-4" />
        {t('quickCommands.commands')}
        <ChevronDown className="w-3 h-3" />
      </button>

      {show && (
        <div className="app-popover scrollbar-modern left-0 w-80">
          {/* 头部 */}
          <div className="app-popover-header">
            <span>{t('quickCommands.title')}</span>
            <div className="flex gap-1">
              <button
                onClick={() => { setShowGroupForm(true); setShowCommandForm(false); }}
                className="icon-button h-7 w-7"
                title={t('quickCommands.newGroup')}
              >
                <FolderUp className="w-4 h-4" />
              </button>
              <button
                onClick={() => { setShowCommandForm(true); setShowGroupForm(false); }}
                className="icon-button h-7 w-7"
                title={t('quickCommands.newCommand')}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 新建分组表单 */}
          {showGroupForm && (
            <div className="border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] p-3">
              <div className="space-y-3">
                <div>
                  <label className="industrial-field-label">{t('quickCommands.groupName')}</label>
                  <input
                    type="text"
                    value={newGroup.name}
                    onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                    placeholder={t('quickCommands.groupName')}
                    className="industrial-input w-full py-1.5"
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
                    <span className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-500">
                      <GroupColorSwatch color={newGroup.color} size="sm" />
                      {newGroup.color.toUpperCase()}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button type="button" onClick={handleSaveGroup} className="industrial-button-primary flex-1 px-2 py-1.5 text-xs">
                    {t('common.save')}
                  </button>
                  <button type="button" onClick={() => setShowGroupForm(false)} className="industrial-button-secondary flex-1 px-2 py-1.5 text-xs">
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 新建命令表单 */}
          {showCommandForm && (
            <div className="border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] p-3">
              <div className="space-y-2">
                <input
                  type="text"
                  value={newCommand.name}
                  onChange={(e) => setNewCommand({ ...newCommand, name: e.target.value })}
                  placeholder={t('quickCommands.commandName')}
                  className="industrial-input w-full py-1.5"
                />
                <input
                  type="text"
                  value={newCommand.command}
                  onChange={(e) => setNewCommand({ ...newCommand, command: e.target.value })}
                  placeholder={t('quickCommands.commandContent')}
                  className="industrial-input w-full py-1.5 font-mono"
                />
                <input
                  type="text"
                  value={newCommand.description}
                  onChange={(e) => setNewCommand({ ...newCommand, description: e.target.value })}
                  placeholder={t('quickCommands.description')}
                  className="industrial-input w-full py-1.5"
                />
                {groups.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="industrial-field-label mb-0">{t('quickCommands.group')}</label>
                    {/* 自定义分组选择：色点 + 名称，与列表样式一致 */}
                    <div className="industrial-card max-h-36 space-y-0.5 overflow-y-auto p-1">
                      <button
                        type="button"
                        onClick={() => setNewCommand({ ...newCommand, groupId: '' })}
                        className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                          !newCommand.groupId
                            ? 'bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-slate-900 dark:text-white'
                            : 'text-slate-600 hover:bg-[color-mix(in_srgb,var(--bg-hover)_70%,transparent)] dark:text-slate-300'
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
                          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                            newCommand.groupId === group.id
                              ? 'bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-slate-900 dark:text-white'
                              : 'text-slate-600 hover:bg-[color-mix(in_srgb,var(--bg-hover)_70%,transparent)] dark:text-slate-300'
                          }`}
                        >
                          <GroupColorSwatch color={group.color || DEFAULT_GROUP_COLOR} size="sm" />
                          <span className="truncate">{group.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex gap-1">
                  <button type="button" onClick={handleSaveCommand} className="industrial-button-primary flex-1 px-2 py-1.5 text-xs">
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCommandForm(false);
                      setEditingCommand(null);
                      setNewCommand({ name: '', command: '', description: '', groupId: '' });
                    }}
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
              <div className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
                {t('quickCommands.noCommands')}
              </div>
            ) : (
              <>
                {groups.map((group) => {
                  const groupCmds = commands.filter((c) => c.groupId === group.id);
                  const groupColor = group.color || DEFAULT_GROUP_COLOR;
                  return (
                    <div key={group.id} className="mb-3">
                      <div className="mb-1 flex items-center justify-between border-b border-[color-mix(in_srgb,var(--border-color)_56%,transparent)] px-2 py-1.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <GroupColorSwatch color={groupColor} size="sm" title={groupColor} />
                          <span className="truncate text-xs font-semibold text-slate-700 dark:text-slate-300">
                            {group.name}
                          </span>
                          <span className="text-[10px] text-slate-500">{groupCmds.length}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDeleteGroup(group.id)}
                          className="icon-button h-6 w-6 hover:text-danger"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      {groupCmds.length === 0 ? (
                        <p className="px-2 py-1.5 text-[11px] text-slate-500">{t('quickCommands.emptyGroup')}</p>
                      ) : (
                        groupCmds.map((cmd) => (
                          <CommandItem
                            key={cmd.id}
                            cmd={cmd}
                            onPaste={handlePaste}
                            onEdit={(c) => {
                              setEditingCommand(c);
                              setNewCommand({
                                name: c.name,
                                command: c.command,
                                description: c.description || '',
                                groupId: c.groupId || '',
                              });
                              setShowCommandForm(true);
                              setShowGroupForm(false);
                            }}
                            onDelete={handleDeleteCommand}
                          />
                        ))
                      )}
                    </div>
                  );
                })}

                {commands.filter((c) => !c.groupId).map((cmd) => (
                  <CommandItem
                    key={cmd.id}
                    cmd={cmd}
                    onPaste={handlePaste}
                    onEdit={(c) => {
                      setEditingCommand(c);
                      setNewCommand({
                        name: c.name,
                        command: c.command,
                        description: c.description || '',
                        groupId: c.groupId || '',
                      });
                      setShowCommandForm(true);
                      setShowGroupForm(false);
                    }}
                    onDelete={handleDeleteCommand}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CommandItem({ cmd, onPaste, onEdit, onDelete }: {
  cmd: QuickCommand;
  onPaste: (command: string) => void;
  onEdit: (cmd: QuickCommand) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="group mx-1 flex items-center rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[color-mix(in_srgb,var(--border-color)_62%,transparent)] hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]">
      <button onClick={() => onPaste(cmd.command)} className="flex-1 text-left">
        <div className="text-sm text-slate-900 dark:text-white font-medium">{cmd.name}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">{cmd.command}</div>
      </button>
      <div className="hidden group-hover:flex items-center gap-1">
        <button onClick={() => onEdit(cmd)} className="icon-button h-6 w-6">
          <Pencil className="w-3 h-3" />
        </button>
        <button onClick={() => onDelete(cmd.id)} className="icon-button h-6 w-6 hover:text-danger">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
