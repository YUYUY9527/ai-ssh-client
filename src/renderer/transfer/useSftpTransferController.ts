import { useCallback, useEffect } from 'react';

import type {
  SftpConflictPolicy,
  SftpLocalFileRef,
  SftpTransferTaskSnapshot,
} from '../../shared/ipc-types';
import { useSftpTransferStore } from '../store/useSftpTransferStore';

interface SftpTransferController {
  cancel: (taskId: string) => Promise<string | undefined>;
  discard: (taskId: string) => Promise<string | undefined>;
  download: (remotePaths: string[]) => Promise<string | undefined>;
  resolveConflict: (input: {
    taskId: string;
    attempt: number;
    policy: Exclude<SftpConflictPolicy, 'ask'>;
    renamedPath?: string;
    applyToBatch?: boolean;
  }) => Promise<string | undefined>;
  retry: (taskId: string) => Promise<string | undefined>;
  upload: (files?: SftpLocalFileRef[]) => Promise<string | undefined>;
  uploadDroppedFiles: (files: File[]) => Promise<string | undefined>;
}

function resultError(result: { success: boolean; error?: string }): string | undefined {
  return result.success ? undefined : result.error || 'SFTP transfer request failed';
}

/** Coordinates the shared SFTP task protocol for one connection. */
export function useSftpTransferController(
  connectionId: string,
  remoteDirectory: string,
  onTasksCreated?: (tasks: SftpTransferTaskSnapshot[]) => void,
): SftpTransferController {
  const applyTransferEvent = useSftpTransferStore((state) => state.applyTransferEvent);
  const upsertSnapshot = useSftpTransferStore((state) => state.upsertSnapshot);

  useEffect(() => {
    if (!window.electronAPI) return undefined;

    const unlisten = window.electronAPI.onSftpTransferEvent(applyTransferEvent);
    void window.electronAPI.listSftpTransfers(connectionId).then((result) => {
      if (result.success) {
        result.data.tasks.forEach(upsertSnapshot);
      }
    });
    return unlisten;
  }, [applyTransferEvent, connectionId, upsertSnapshot]);

  const upload = useCallback(async (files?: SftpLocalFileRef[]) => {
    if (!window.electronAPI) return 'SFTP bridge is unavailable';
    let selected = files;
    if (!selected?.length) {
      const selection = await window.electronAPI.selectSftpFiles();
      if (!selection.success) return selection.error || 'Unable to select files';
      if (selection.data.canceled) return undefined;
      selected = selection.data.files;
    }
    const result = await window.electronAPI.startSftpUpload({
      connectionId,
      files: selected,
      remoteDirectory,
      conflictPolicy: 'ask',
    });
    if (result.success) {
      result.data.tasks.forEach(upsertSnapshot);
      onTasksCreated?.(result.data.tasks);
    }
    return resultError(result);
  }, [connectionId, onTasksCreated, remoteDirectory, upsertSnapshot]);

  /** 拖放文件：优先注册真实 File/path，否则回退选择器。 */
  const uploadDroppedFiles = useCallback(async (files: File[]) => {
    if (!window.electronAPI) return 'SFTP bridge is unavailable';
    if (!files.length) return undefined;

    if (window.electronAPI.prepareSftpLocalFiles) {
      const prepared = window.electronAPI.prepareSftpLocalFiles(files);
      if (prepared.success && prepared.data.files.length > 0) {
        return upload(prepared.data.files);
      }
    }

    // 桌面 DOM drop 可能拿不到本地路径时回退多选对话框。
    return upload();
  }, [upload]);

  const download = useCallback(async (remotePaths: string[]) => {
    if (!window.electronAPI) return 'SFTP bridge is unavailable';
    if (!remotePaths.length) return undefined;

    const selection = await window.electronAPI.selectSftpDownloadDestination();
    if (!selection.success) return selection.error || 'Unable to select a download destination';
    if (selection.data.canceled) return undefined;

    // Web 可返回空 destination，由浏览器下载管理器接管。
    const destination = selection.data.destination || { name: 'browser-download' };
    const result = await window.electronAPI.startSftpDownload({
      connectionId,
      remotePaths,
      destination,
      conflictPolicy: 'ask',
    });
    if (result.success) {
      result.data.tasks.forEach(upsertSnapshot);
      onTasksCreated?.(result.data.tasks);
    }
    return resultError(result);
  }, [connectionId, onTasksCreated, upsertSnapshot]);

  const cancel = useCallback(async (taskId: string) => {
    if (!window.electronAPI) return 'SFTP bridge is unavailable';
    return resultError(await window.electronAPI.cancelSftpTransfer({ taskId }));
  }, []);

  const retry = useCallback(async (taskId: string) => {
    if (!window.electronAPI) return 'SFTP bridge is unavailable';
    const result = await window.electronAPI.retrySftpTransfer({ taskId });
    if (result.success) upsertSnapshot(result.data);
    return resultError(result);
  }, [upsertSnapshot]);

  const discard = useCallback(async (taskId: string) => {
    if (!window.electronAPI) return 'SFTP bridge is unavailable';
    return resultError(await window.electronAPI.discardSftpTransfer({ taskId }));
  }, []);

  const resolveConflict = useCallback(async (input: {
    taskId: string;
    attempt: number;
    policy: Exclude<SftpConflictPolicy, 'ask'>;
    renamedPath?: string;
    applyToBatch?: boolean;
  }) => {
    if (!window.electronAPI) return 'SFTP bridge is unavailable';
    return resultError(await window.electronAPI.resolveSftpConflict(input));
  }, []);

  return {
    cancel,
    discard,
    download,
    resolveConflict,
    retry,
    upload,
    uploadDroppedFiles,
  };
}
