import type {
  DirectoryListResult,
  IPCResult,
  SftpBatchDeleteResult,
  SftpDownloadDestinationSelectionResult,
  SftpFilesSelectionResult,
  SftpListTransfersResult,
  SftpResolveConflictRequest,
  SftpStartDownloadRequest,
  SftpStartTransferResult,
  SftpStartUploadRequest,
  SftpTransferEvent,
  SftpTransferTaskRequest,
  SftpTransferTaskSnapshot,
} from '../../../shared/ipc-types';

export type SftpInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<IPCResult<T>>;

type SftpListener = <T>(
  eventName: string,
  callback: (event: T) => void,
) => () => void;

/** 创建桌面端 SFTP IPC bridge，避免与通用 Tauri bridge 循环依赖。 */
export function createNativeSftpApi(invoke: SftpInvoker, listen: SftpListener) {
  return {
    listDirectory: (connectionId: string, remotePath: string) => (
      invoke<DirectoryListResult>('sftp_list_directory', { connectionId, remotePath })
    ),
    selectSftpFiles: () => invoke<SftpFilesSelectionResult>('sftp_select_files'),
    selectSftpDownloadDestination: () => (
      invoke<SftpDownloadDestinationSelectionResult>('sftp_select_download_destination')
    ),
    /** 桌面拖放：仅当 File 暴露 path 时可用，否则由 UI 回退选择器。 */
    prepareSftpLocalFiles: (files: File[]): IPCResult<SftpFilesSelectionResult> => {
      const prepared = files
        .map((file) => {
          const path = (file as File & { path?: string }).path;
          if (!path || !file.name || file.name.includes('/') || file.name.includes('\\')) {
            return null;
          }
          return {
            name: file.name,
            path,
            size: file.size,
            lastModified: file.lastModified,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item != null);
      if (prepared.length === 0) {
        return { success: false, error: 'Dropped files do not include local paths' };
      }
      return { success: true, data: { canceled: false, files: prepared } };
    },
    createSftpDirectory: (connectionId: string, remotePath: string) => (
      invoke<void>('sftp_create_directory', { connectionId, remotePath })
    ),
    deleteSftpItems: (connectionId: string, remotePaths: string[]) => (
      invoke<SftpBatchDeleteResult>('sftp_delete_items', { connectionId, remotePaths })
    ),
    startSftpUpload: (request: SftpStartUploadRequest) => (
      invoke<SftpStartTransferResult>('sftp_start_upload', { request })
    ),
    startSftpDownload: (request: SftpStartDownloadRequest) => (
      invoke<SftpStartTransferResult>('sftp_start_download', { request })
    ),
    resolveSftpConflict: (request: SftpResolveConflictRequest) => (
      invoke<void>('sftp_resolve_conflict', { request })
    ),
    cancelSftpTransfer: (request: SftpTransferTaskRequest) => (
      invoke<void>('sftp_cancel_transfer', { request })
    ),
    retrySftpTransfer: (request: SftpTransferTaskRequest) => (
      invoke<SftpTransferTaskSnapshot>('sftp_retry_transfer', { request })
    ),
    discardSftpTransfer: (request: SftpTransferTaskRequest) => (
      invoke<void>('sftp_discard_transfer', { request })
    ),
    listSftpTransfers: (connectionId?: string) => (
      invoke<SftpListTransfersResult>('sftp_list_transfers', { connectionId })
    ),
    onSftpTransferEvent: (callback: (event: SftpTransferEvent) => void) => (
      listen('sftp-transfer-event', callback)
    ),
    renameItem: (connectionId: string, remotePath: string, newName: string) => (
      invoke<void>('sftp_rename_item', { connectionId, remotePath, newName })
    ),
    deleteItem: (connectionId: string, remotePath: string) => (
      invoke<void>('sftp_delete_item', { connectionId, remotePath })
    ),
  };
}
