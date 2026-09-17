/** 将剪贴板换行规范为终端回车序列。 */
export function prepareTerminalPaste(text: string): string {
  return text.replace(/\r?\n/g, '\r');
}

/** 判断文本是否包含换行（多行粘贴）。 */
export function isMultiLinePaste(text: string): boolean {
  return /[\r\n]/.test(text);
}

export type PasteGateResult =
  | { action: 'send'; text: string }
  | { action: 'confirm'; previewText: string; preparedText: string }
  | { action: 'skip' };

/**
 * 粘贴安全门控：单行直接发送；多行需确认后才返回可发送文本。
 * @param text 原始剪贴板文本
 * @param confirmed 用户是否已在预览中确认
 */
export function gateTerminalPaste(text: string, confirmed = false): PasteGateResult {
  if (!text) {
    return { action: 'skip' };
  }

  const preparedText = prepareTerminalPaste(text);

  if (!isMultiLinePaste(text)) {
    return { action: 'send', text: preparedText };
  }

  if (confirmed) {
    return { action: 'send', text: preparedText };
  }

  return {
    action: 'confirm',
    previewText: text,
    preparedText,
  };
}

/**
 * 解析确认结果：确认返回可发送文本，取消返回空串（不发送）。
 */
export function resolvePasteConfirmation(preparedText: string, confirmed: boolean): string {
  if (!confirmed || !preparedText) {
    return '';
  }
  return preparedText;
}

/** Ctrl+V 剪贴板兜底的等待窗口：超过该时间仍未收到原生 paste 事件才主动读剪贴板。 */
export const CLIPBOARD_PASTE_FALLBACK_MS = 150;

export interface ClipboardPasteFallback {
  /** 原生 paste 事件已发送该次粘贴：取消尚未触发的兜底。 */
  markHandled: () => void;
  /** Ctrl+V 按下：安排一次兜底发送，窗口内出现 paste 事件则自动作废。 */
  arm: (onFallback: () => void, delayMs?: number) => void;
  /** 终端实例销毁：取消未决的兜底，避免把内容发到下一个会话。 */
  cancel: () => void;
}

/**
 * 粘贴发送去重闸门。
 *
 * Ctrl+V 有两条可能路径：浏览器原生 paste 事件、Clipboard API 主动读取。
 * 安全上下文（HTTPS/localhost）下两者都会触发，若都直接发送就会粘贴两遍，
 * 因此让 paste 事件作为唯一正常路径，Clipboard API 只在窗口期内没有 paste 事件时兜底
 * （个别 webview 不派发 paste 事件）。
 */
export function createClipboardPasteFallback(
  schedule: (callback: () => void, delayMs: number) => unknown = (callback, delayMs) => setTimeout(callback, delayMs),
): ClipboardPasteFallback {
  let pending: { handled: boolean } | null = null;

  return {
    markHandled() {
      if (pending) {
        pending.handled = true;
      }
    },
    arm(onFallback, delayMs = CLIPBOARD_PASTE_FALLBACK_MS) {
      const ticket = { handled: false };
      pending = ticket;
      schedule(() => {
        if (pending === ticket) {
          pending = null;
        }
        if (!ticket.handled) {
          onFallback();
        }
      }, delayMs);
    },
    cancel() {
      if (pending) {
        pending.handled = true;
        pending = null;
      }
    },
  };
}
