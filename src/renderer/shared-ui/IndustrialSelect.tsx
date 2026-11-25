import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface IndustrialSelectOption {
  value: string;
  label: string;
}

interface IndustrialSelectProps {
  id?: string;
  value: string;
  options: IndustrialSelectOption[];
  onChange: (value: string) => void;
  /** 可选：无匹配时展示文案 */
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
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
  id,
  value,
  options,
  onChange,
  placeholder = '',
  className = '',
  disabled = false,
  ariaLabel,
  ariaLabelledBy,
  'data-terminal-setting': dataTerminalSetting,
}: IndustrialSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const selectedIndex = options.findIndex((item) => item.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const displayLabel = selected?.label ?? placeholder;

  /** 根据触发器位置计算 fixed 菜单坐标，避免被 overflow 容器裁切。 */
  const updateMenuPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    if (rect.bottom < 0 || rect.top > viewportH || rect.width === 0) {
      setOpen(false);
      return;
    }
    const spaceBelow = viewportH - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const preferredMax = 224; // ~max-h-56
    const openUpward = spaceBelow < 140 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(preferredMax, openUpward ? spaceAbove : spaceBelow));
    const width = Math.min(rect.width, viewportW - 16);
    const left = Math.max(8, Math.min(rect.left, viewportW - width - 8));
    setMenuPos({
      top: openUpward ? rect.top - 6 : rect.bottom + 6,
      left,
      width,
      maxHeight,
      openUpward,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    updateMenuPosition();
    const handleReposition = () => updateMenuPosition();
    window.addEventListener('resize', handleReposition);
    // 捕获滚动（含设置面板内部滚动）
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open || activeIndex < 0) {
      return;
    }
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // 点击外部 / Esc 关闭（Esc 在捕获阶段拦截，避免直接关掉外层 Modal）
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
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || options.length === 0) {
      return;
    }
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? options.length - 1 : prev - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (activeIndex >= 0 && options[activeIndex]) {
        event.preventDefault();
        onChange(options[activeIndex].value);
        setOpen(false);
      }
    }
  };

  const menu = open && menuPos
    ? createPortal(
      <div
        ref={menuRef}
        id={listId}
        role="listbox"
        className="app-popover industrial-select-menu z-tooltip py-1 scrollbar-modern"
        style={{
          position: 'fixed',
          top: menuPos.openUpward ? 'auto' : menuPos.top,
          bottom: menuPos.openUpward ? window.innerHeight - menuPos.top : 'auto',
          left: menuPos.left,
          width: menuPos.width,
          maxHeight: menuPos.maxHeight,
          marginTop: 0,
          overflowY: 'auto',
        }}
      >
        {options.map((option, idx) => {
          const isActive = option.value === value;
          const isHighlighted = idx === activeIndex;
          return (
            <button
              key={option.value}
              ref={(el) => {
                optionRefs.current[idx] = el;
              }}
              type="button"
              role="option"
              aria-selected={isActive}
              title={option.label}
              className={`app-popover-row text-sm ${
                isActive
                  ? 'bg-[color-mix(in_srgb,var(--accent-primary)_22%,transparent)] font-medium text-fg'
                  : isHighlighted
                    ? 'bg-surface-hover text-fg'
                    : 'text-fg-secondary'
              }`}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
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
        id={id}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        title={displayLabel}
        data-terminal-setting={dataTerminalSetting}
        className={`industrial-select-trigger ${open ? 'industrial-select-trigger-open' : ''}`}
        onKeyDown={handleTriggerKeyDown}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev);
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate text-left">{displayLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {menu}
    </div>
  );
}
