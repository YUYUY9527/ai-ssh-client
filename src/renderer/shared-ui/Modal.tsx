import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

/** Modal 尺寸档位到最大宽度类的映射 */
const SIZE_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
} as const;

/** 可聚焦元素选择器，用于焦点陷阱与初始聚焦 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 传入则渲染标准头部（标题 + 关闭按钮） */
  title?: ReactNode;
  size?: keyof typeof SIZE_CLASS;
  /** 点击遮罩是否关闭，默认 true */
  closeOnBackdrop?: boolean;
  /** 按 Esc 是否关闭，默认 true */
  closeOnEsc?: boolean;
  /** 是否显示头部右上角关闭按钮，默认 true */
  showClose?: boolean;
  closeLabel?: string;
  /** 打开时优先聚焦的元素 */
  initialFocusRef?: RefObject<HTMLElement>;
  /** 追加到面板的额外类（如彩色边框） */
  panelClassName?: string;
  labelledBy?: string;
  describedBy?: string;
}

/** 通用模态框基座：统一遮罩、居中、进出动画、Esc 关闭、点遮罩关闭、焦点陷阱与滚动锁定 */
export function Modal({
  isOpen,
  onClose,
  children,
  title,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEsc = true,
  showClose = true,
  closeLabel = 'Close',
  initialFocusRef,
  panelClassName,
  labelledBy,
  describedBy,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // 打开期间处理焦点管理、Esc 关闭、Tab 焦点陷阱与 body 滚动锁定
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // 记录打开前的焦点元素，关闭后恢复
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 下一帧将焦点移入弹窗（优先指定元素，否则第一个可聚焦元素）
    const focusFrame = requestAnimationFrame(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable ?? panel).focus();
    });

    // 键盘处理：Esc 关闭、Tab 在弹窗内循环
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEsc) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      // 收集当前可见的可聚焦元素
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // 到达边界时循环到另一端，保持焦点不逃出弹窗
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = originalOverflow;
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen, closeOnEsc, onClose, initialFocusRef]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`industrial-modal relative w-full ${SIZE_CLASS[size]} animate-in fade-in zoom-in-95 duration-200 ${panelClassName ?? ''}`}
      >
        {title != null && (
          <div className="industrial-modal-header">
            <h3 className="font-semibold text-slate-900 dark:text-white">{title}</h3>
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                className="icon-button"
                aria-label={closeLabel}
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
