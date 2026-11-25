import { useEffect, useState } from 'react';

interface MobileKeyBarProps {
  mode?: 'auto' | 'on' | 'off';
  disabled?: boolean;
  onSendSequence: (seq: string) => void;
}

/**
 * 移动端 / 触摸屏底部虚拟快捷键栏：
 * 提供 Esc / Tab / Ctrl / Alt（粘滞修饰键）/ 方向键 / 常用符号（| / - ~）及 Ctrl+C / Ctrl+D。
 * mode='auto' 时仅在触摸设备或窄屏（<768px）显示；mode='on' 始终显示；mode='off' 隐藏。
 */
export function MobileKeyBar({ mode = 'auto', disabled = false, onSendSequence }: MobileKeyBarProps) {
  const [visible, setVisible] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);

  useEffect(() => {
    if (mode === 'on') {
      setVisible(true);
      return undefined;
    }
    if (mode === 'off') {
      setVisible(false);
      return undefined;
    }
    const evaluate = () => {
      const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)').matches
        : false;
      const narrow = typeof window !== 'undefined' ? window.innerWidth < 768 : false;
      setVisible(coarse || narrow);
    };
    evaluate();
    window.addEventListener('resize', evaluate);
    return () => window.removeEventListener('resize', evaluate);
  }, [mode]);

  if (!visible || disabled) return null;

  const sendChar = (ch: string) => {
    let seq = ch;
    if (ctrlArmed && ch.length === 1) {
      const upper = ch.toUpperCase().charCodeAt(0);
      if (upper >= 64 && upper <= 95) {
        seq = String.fromCharCode(upper - 64);
      }
      setCtrlArmed(false);
    }
    if (altArmed) {
      seq = `\x1b${seq}`;
      setAltArmed(false);
    }
    onSendSequence(seq);
  };

  const keys: Array<{ label: string; action: () => void; active?: boolean }> = [
    { label: 'ESC', action: () => onSendSequence('\x1b') },
    { label: 'TAB', action: () => onSendSequence('\t') },
    { label: 'CTRL', active: ctrlArmed, action: () => setCtrlArmed((v) => !v) },
    { label: 'ALT', active: altArmed, action: () => setAltArmed((v) => !v) },
    { label: '^C', action: () => onSendSequence('\x03') },
    { label: '^D', action: () => onSendSequence('\x04') },
    { label: '↑', action: () => onSendSequence('\x1b[A') },
    { label: '↓', action: () => onSendSequence('\x1b[B') },
    { label: '←', action: () => onSendSequence('\x1b[D') },
    { label: '→', action: () => onSendSequence('\x1b[C') },
    { label: '|', action: () => sendChar('|') },
    { label: '/', action: () => sendChar('/') },
    { label: '-', action: () => sendChar('-') },
    { label: '~', action: () => sendChar('~') },
  ];

  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line-subtle bg-surface px-2 py-1.5 scrollbar-thin"
      data-mobile-key-bar
    >
      {keys.map((item) => (
        <button
          key={item.label}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={item.action}
          className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
            item.active
              ? 'border-accent bg-accent-muted text-accent'
              : 'border-line-subtle bg-surface-raised text-fg-secondary active:bg-surface-hover'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
