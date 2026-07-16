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
