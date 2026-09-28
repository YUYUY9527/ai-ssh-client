import { t } from '../i18n';

/**
 * 任务完成提醒。
 *
 * 历史缺口：`AgentExecutor` 里的 `notifyTaskCompletion` 是个空实现（`async () => {}`），
 * 运行时每轮都会调用它，但任务跑完后用户切到别的窗口就再也看不到结果 ——
 * i18n 里的 `agent.notifications.*` 也因此从未被使用。
 *
 * 这里只做两件低风险的事：
 * 1. 窗口不在前台时，在标题前面加 ✓/✗ 标记，回到前台自动清除；
 * 2. 仅当浏览器**已经授予**通知权限时才发系统通知 —— 不主动弹权限请求，避免打扰。
 */

const TITLE_MARK_PATTERN = /^(?:[✓✗])\s*/;

/** 在原标题前加完成标记（重复调用不会叠加标记）。 */
export function formatCompletionTitle(originalTitle: string, success: boolean): string {
  const base = originalTitle.replace(TITLE_MARK_PATTERN, '');
  return `${success ? '✓' : '✗'} ${base}`.trimEnd();
}

/** 去掉完成标记。 */
export function stripCompletionTitle(title: string): string {
  return title.replace(TITLE_MARK_PATTERN, '');
}

/** 是否应该发系统通知：只在窗口隐藏且权限已授予时。 */
export function shouldShowDesktopNotice(hidden: boolean, permission: string): boolean {
  return hidden && permission === 'granted';
}

function currentNotificationPermission(): string {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** 任务结束时的提醒入口，接在 `notifyTaskCompletion` 上。 */
export async function notifyAgentTaskCompletion(success: boolean, reason: string): Promise<void> {
  if (typeof document === 'undefined') return;

  try {
    document.title = formatCompletionTitle(document.title, success);

    if (!shouldShowDesktopNotice(document.hidden, currentNotificationPermission())) {
      return;
    }

    // eslint-disable-next-line no-new
    new Notification(
      success ? t('agent.notifications.taskCompleted') : t('agent.notifications.taskFailed'),
      { body: reason.slice(0, 200) },
    );
  } catch {
    // 通知失败不影响任务主流程
  }
}

/** 清除标题标记（回到前台时调用）。 */
export function clearAgentCompletionTitle(): void {
  if (typeof document === 'undefined') return;
  document.title = stripCompletionTitle(document.title);
}

/** 注册「回到前台清除标记」监听，返回解绑函数。 */
export function installCompletionTitleReset(): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => clearAgentCompletionTitle();
  window.addEventListener('focus', handler);
  return () => window.removeEventListener('focus', handler);
}
