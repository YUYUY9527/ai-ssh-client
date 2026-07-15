import type { SftpItem } from '../../shared/ipc-types';

/** SFTP transfer direction used by the transfer domain. */
export type TransferDirection = 'upload' | 'download';

/** 旧界面任务生命周期状态，正式任务使用共享 SftpTransferStatus。 */
export type TransferTaskStatus = 'pending' | 'transferring' | 'completed' | 'error';

/** 远端文件条目直接复用共享 SFTP 契约。 */
export type RemoteFileItem = SftpItem;

/** Per-session SFTP browser UI state. */
export interface SftpBrowserSessionState {
  remotePath: string;
  activeView: 'files' | 'tasks';
  selectedPaths: string[];
  selectionAnchorPath: string | null;
  navigationVersion: number;
}

/** Default remote path when no session memory or cwd is available. */
export const DEFAULT_REMOTE_PATH = '~';

/** Sidebar width clamp. */
export const SFTP_SIDEBAR_MIN_WIDTH = 320;
export const SFTP_SIDEBAR_MAX_WIDTH = 860;

/** Default sidebar width: open at max size. */
export const DEFAULT_SFTP_SIDEBAR_WIDTH = SFTP_SIDEBAR_MAX_WIDTH;
