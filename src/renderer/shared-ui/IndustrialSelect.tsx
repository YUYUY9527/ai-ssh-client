import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface IndustrialSelectOption {
  value: string;
  label: string;
}

interface IndustrialSelectProps {
  value: string;
  options: IndustrialSelectOption[];
  onChange: (value: string) => void;
  /** 可选：无匹配时展示文案 */
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** 测试/定位用 */
  'data-terminal-setting'?: string;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  openUpward: boolean;
}

/** 工业风自定义下拉：触发器对齐 industrial-input，列表复用 app-popover。 */
export function IndustrialSelect({
  value,
  options,
  onChange,
  placeholder = '',
  className = '',
  disabled = false,
  'data-terminal-setting': dataTerminalSetting,
}: IndustrialSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((item) => item.value === value);
  const displayLabel = selected?.label ?? placeholder;

  /** 根据触发器位置计算 fixed 菜单坐标，避免被 overflow 容器裁切。 */
  const updateMenuPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const preferredMax = 224; // ~max-h-56
    const openUpward = spaceBelow < 140 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(preferredMax, openUpward ? spaceAbove : spaceBelow));
    setMenuPos({
      top: openUpward ? rect.top - 6 : rect.bottom + 6,
      left: rect.left,
      width: rect.width,
      maxHeight,
      openUpward,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    updateMenuPosition();
    const handleReposition = () => updateMenuPosition();
    window.addEventListener('resize', handleReposition);
    // 捕获滚动（含设置面板内部滚动）
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const menu = open && menuPos
    ? createPortal(
      <div
        ref={menuRef}
        id={listId}
        role="listbox"
        className="app-popover industrial-select-menu py-1 scrollbar-modern"
        style={{
          position: 'fixed',
          top: menuPos.openUpward ? undefined : menuPos.top,
          bottom: menuPos.openUpward ? window.innerHeight - menuPos.top : undefined,
          left: menuPos.left,
          width: menuPos.width,
          maxHeight: menuPos.maxHeight,
          marginTop: 0,
          overflowY: 'auto',
          zIndex: 200,
        }}
      >
        {options.map((option) => {
          const isActive = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={isActive}
              className={`app-popover-row text-sm ${
                isActive
                  ? 'bg-[color-mix(in_srgb,var(--accent-primary)_22%,transparent)] text-slate-900 dark:text-white'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>,
      document.body,
    )
    : null;

  return (
    <div ref={rootRef} className={`industrial-select-root relative ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        data-terminal-setting={dataTerminalSetting}
        className={`industrial-select-trigger ${open ? 'industrial-select-trigger-open' : ''}`}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev);
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate text-left">{displayLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {menu}
    </div>
  );
}
