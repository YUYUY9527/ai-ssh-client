import type {
  DirectoryListResult,
  FileDownloadResult,
  FileUploadResult,
  IPCResult,
} from '../../../shared/ipc-types';
import { tauriInvoke } from '../native';

export const nativeSftp = {
  listDirectory: (
    connectionId: string,
    remotePath: string,
  ): Promise<IPCResult<DirectoryListResult<any>>> => (
    tauriInvoke<DirectoryListResult<any>>('sftp_list_directory', { connectionId, remotePath })
  ),
  downloadFile: (
    connectionId: string,
    remotePath: string,
    taskId?: string,
  ): Promise<IPCResult<FileDownloadResult>> => (
    tauriInvoke<FileDownloadResult>('sftp_download_file', { connectionId, remotePath, taskId })
  ),
  uploadFile: (
    connectionId: string,
    localPath: string,
    remoteDir: string,
    taskId?: string,
  ): Promise<IPCResult<FileUploadResult>> => (
    tauriInvoke<FileUploadResult>('sftp_upload_file', {
      connectionId,
      localPath,
      remoteDir,
      taskId,
    })
  ),
};
