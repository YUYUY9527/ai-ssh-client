import { useState, useEffect, useRef, useCallback } from 'react';
import { Zap, ChevronDown, FolderUp, Plus, Trash2, Pencil } from 'lucide-react';
import { t } from '../i18n';
import type { QuickCommand, QuickCommandGroup } from '../../shared/types';

interface QuickCommandsPanelProps {
  onPasteCommand: (command: string) => void;
}

export function QuickCommandsPanel({ onPasteCommand }: QuickCommandsPanelProps) {
  const [show, setShow] = useState(false);
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [groups, setGroups] = useState<QuickCommandGroup[]>([]);
  const [editingCommand, setEditingCommand] = useState<QuickCommand | null>(null);
  const [newCommand, setNewCommand] = useState({ name: '', command: '', description: '', groupId: '' });
  const [newGroup, setNewGroup] = useState({ name: '', color: '#3B82F6' });
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
    setNewGroup({ name: '', color: '#3B82F6' });
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
              <div className="space-y-2">
                <input
                  type="text"
                  value={newGroup.name}
                  onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                  placeholder={t('quickCommands.groupName')}
                  className="industrial-input w-full py-1"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={newGroup.color}
                    onChange={(e) => setNewGroup({ ...newGroup, color: e.target.value })}
                    className="h-8 w-8 cursor-pointer rounded-sm border border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] bg-transparent p-0.5"
                  />
                  <div className="flex-1 flex gap-1">
                    <button onClick={handleSaveGroup} className="industrial-button-primary flex-1 px-2 py-1 text-xs">
                      {t('common.save')}
                    </button>
                    <button onClick={() => setShowGroupForm(false)} className="industrial-button-secondary flex-1 px-2 py-1 text-xs">
                      {t('common.cancel')}
                    </button>
                  </div>
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
                  className="industrial-input w-full py-1"
                />
                <input
                  type="text"
                  value={newCommand.command}
                  onChange={(e) => setNewCommand({ ...newCommand, command: e.target.value })}
                  placeholder={t('quickCommands.commandContent')}
                  className="industrial-input w-full py-1 font-mono"
                />
                <input
                  type="text"
                  value={newCommand.description}
                  onChange={(e) => setNewCommand({ ...newCommand, description: e.target.value })}
                  placeholder={t('quickCommands.description')}
                  className="industrial-input w-full py-1"
                />
                {groups.length > 0 && (
                  <select
                    value={newCommand.groupId}
                    onChange={(e) => setNewCommand({ ...newCommand, groupId: e.target.value })}
                    className="industrial-input w-full py-1"
                  >
                    <option value="">{t('quickCommands.noGroup')}</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                )}
                <div className="flex gap-1">
                  <button onClick={handleSaveCommand} className="industrial-button-primary flex-1 px-2 py-1 text-xs">
                    {t('common.save')}
                  </button>
                  <button onClick={() => setShowCommandForm(false)} className="industrial-button-secondary flex-1 px-2 py-1 text-xs">
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 命令列表 */}
          <div className="p-2">
            {commands.length === 0 && !showCommandForm && !showGroupForm ? (
              <div className="text-center text-slate-500 dark:text-slate-400 text-sm py-4">
                {t('quickCommands.noCommands')}
              </div>
            ) : (
              <>
                {groups.map((group) => {
                  const groupCmds = commands.filter(c => c.groupId === group.id);
                  if (groupCmds.length === 0) return null;
                  return (
                    <div key={group.id} className="mb-3">
                      <div className="mb-1 flex items-center justify-between border-b border-[color-mix(in_srgb,var(--border-color)_56%,transparent)] px-2 py-1">
                        <div className="flex items-center gap-2">
                          <div className="h-3 w-3 rounded-sm border border-white/20" style={{ backgroundColor: group.color }} />
                          <span className="text-xs font-semibold uppercase text-slate-700 dark:text-slate-300">{group.name}</span>
                        </div>
                        <button onClick={() => handleDeleteGroup(group.id)} className="icon-button h-6 w-6 hover:text-danger">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {groupCmds.map((cmd) => (
                        <CommandItem
                          key={cmd.id}
                          cmd={cmd}
                          onPaste={handlePaste}
                          onEdit={(c) => {
                            setEditingCommand(c);
                            setNewCommand({ name: c.name, command: c.command, description: c.description || '', groupId: c.groupId || '' });
                            setShowCommandForm(true);
                          }}
                          onDelete={handleDeleteCommand}
                        />
                      ))}
                    </div>
                  );
                })}

                {commands.filter(c => !c.groupId).map((cmd) => (
                  <CommandItem
                    key={cmd.id}
                    cmd={cmd}
                    onPaste={handlePaste}
                    onEdit={(c) => {
                      setEditingCommand(c);
                      setNewCommand({ name: c.name, command: c.command, description: c.description || '', groupId: c.groupId || '' });
                      setShowCommandForm(true);
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
