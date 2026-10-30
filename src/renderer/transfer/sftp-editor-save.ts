/**
 * 远端文本编辑器的“是否允许保存”判定。
 *
 * 单独抽成纯函数，确保按钮 disabled、Ctrl/Cmd+S 快捷键走的是**同一套条件**：
 * 必须已经成功加载过文件（loaded），且没有在加载/保存、内容有改动、未超限。
 * 读取失败时 loaded 保持 false，此时无论 draft 是什么都不允许写回，避免把远端
 * 文件清空。
 */
export interface SftpEditorSaveState {
  /** 是否已成功读取过远端文件（读取失败时为 false）。 */
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  /** 当前草稿与已加载内容是否不同。 */
  dirty: boolean;
  /** 草稿字节数是否超过上限。 */
  overLimit: boolean;
}

export function canSaveSftpDraft(state: SftpEditorSaveState): boolean {
  return Boolean(
    state.loaded
    && !state.loading
    && !state.saving
    && state.dirty
    && !state.overLimit,
  );
}
