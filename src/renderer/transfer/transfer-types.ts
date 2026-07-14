/** SFTP transfer direction used by the transfer domain. */
export type TransferDirection = 'upload' | 'download';

/** Transfer task lifecycle states. */
export type TransferTaskStatus = 'pending' | 'transferring' | 'completed' | 'error';

/** Remote file entry returned by directory listing. */
export interface RemoteFileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  fileType: string;
}

/** Per-session SFTP browser UI state. */
export interface SftpBrowserSessionState {
  remotePath: string;
  activeView: 'files' | 'tasks';
  selectedPath: string | null;
  navigationVersion: number;
}

/** Default remote path when no session memory or cwd is available. */
export const DEFAULT_REMOTE_PATH = '/home';

/** Default sidebar width in pixels. */
export const DEFAULT_SFTP_SIDEBAR_WIDTH = 480;

/** Sidebar width clamp. */
export const SFTP_SIDEBAR_MIN_WIDTH = 320;
export const SFTP_SIDEBAR_MAX_WIDTH = 860;
