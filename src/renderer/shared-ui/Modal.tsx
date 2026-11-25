import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useSessionOverlay } from '../workspace/SessionOverlayContext';

/** Modal 尺寸档位到最大宽度类的映射 */
const SIZE_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  /** 宽编辑器 / 设置类 */
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-5xl',
  /** 接近全屏的编辑区 */
  '4xl': 'max-w-6xl',
} as const;

/** 可聚焦元素选择器，用于焦点陷阱 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 表单字段优先于关闭按钮，避免打开时焦点落到标题栏 X 上 */
const PREFERRED_FOCUS_SELECTOR =
  'input:not([disabled]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])';

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
  /** 弹层作用域：auto（默认）在会话上下文内绑定当前会话且不遮挡会话标签栏；global 强制覆盖全屏。 */
  scope?: 'auto' | 'global';
  /** 是否通过 createPortal 挂载（默认 true；顶层组件如 SettingsPanel 可设为 false 以原地挂载并保留完整弹窗能力）。 */
  usePortal?: boolean;
}

/** 全局弹窗 body 滚动锁引用计数，避免嵌套弹窗提前解锁。 */
let globalBodyScrollLockCount = 0;
let savedBodyOverflow = '';

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
  scope = 'auto',
  usePortal = true,
}: ModalProps) {
  const overlay = useSessionOverlay();
  const isSessionScoped = scope !== 'global' && Boolean(overlay.container);
  const isInteractive = isOpen && (!isSessionScoped || overlay.isActive);

  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // 用 ref 持有回调，避免父组件每次渲染新建 onClose 时重跑焦点副作用
  const onCloseRef = useRef(onClose);
  const closeOnEscRef = useRef(closeOnEsc);
  const initialFocusRefHolder = useRef(initialFocusRef);
  onCloseRef.current = onClose;
  closeOnEscRef.current = closeOnEsc;
  initialFocusRefHolder.current = initialFocusRef;

  // 全局弹窗锁定 body 滚动并在关闭时还原焦点；会话内弹窗不锁 body，避免影响切换标签
  useEffect(() => {
    if (!isOpen || isSessionScoped) {
      return;
    }
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    if (globalBodyScrollLockCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    globalBodyScrollLockCount += 1;
    return () => {
      globalBodyScrollLockCount = Math.max(0, globalBodyScrollLockCount - 1);
      if (globalBodyScrollLockCount === 0) {
        document.body.style.overflow = savedBodyOverflow;
      }
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen, isSessionScoped]);

  // 仅在弹窗打开且所属会话处于激活可见态时绑定快捷键与焦点陷阱，切换至其他会话后互不干扰
  useEffect(() => {
    if (!isInteractive) {
      return;
    }

    const focusFrame = requestAnimationFrame(() => {
      const preferred = initialFocusRefHolder.current?.current;
      if (preferred) {
        preferred.focus();
        return;
      }
      const panel = panelRef.current;
      if (!panel || panel.offsetParent === null) {
        return;
      }
      const formField = panel.querySelector<HTMLElement>(PREFERRED_FOCUS_SELECTOR);
      const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (formField ?? firstFocusable ?? panel).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || panel.offsetParent === null) {
        return;
      }
      // 全局弹层（如设置、连接编辑）优先处理键盘事件，避免被底层会话弹窗截走 Esc
      if (isSessionScoped && document.querySelector('[role="dialog"][data-modal-scope="global"]')) {
        return;
      }
      if (event.key === 'Escape' && closeOnEscRef.current) {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
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
      if (event.shiftKey && (active === first || active === panel || !active || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !active || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isInteractive, isSessionScoped]);

  if (!isOpen) {
    return null;
  }

  const portalTarget = isSessionScoped && overlay.container ? overlay.container : document.body;
  const wrapperClass = isSessionScoped
    ? 'pointer-events-auto absolute inset-0 z-overlay flex items-center justify-center overflow-y-auto p-4'
    : 'fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4';
  const maxHeightClass = isSessionScoped
    ? 'max-h-full'
    : 'max-h-[min(90vh,calc(100vh-2rem))]';

  const modalNode = (
    <div className={wrapperClass}>
      <div
        className="modal-backdrop"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        data-modal-scope={isSessionScoped ? 'session' : 'global'}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`industrial-modal relative my-auto ${maxHeightClass} w-full overflow-y-auto ${SIZE_CLASS[size]} ${panelClassName ?? ''}`}
      >
        {title != null && (
          <div className="industrial-modal-header shrink-0">
            <h3 className="min-w-0 flex-1 font-semibold text-fg">{title}</h3>
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                className="icon-button shrink-0"
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

  // 会话内弹层挂载至当前会话专属宿主（.app-main 内），不遮挡顶栏与会话列表；其余全局弹窗挂载至 body
  return usePortal ? createPortal(modalNode, portalTarget) : modalNode;
}
