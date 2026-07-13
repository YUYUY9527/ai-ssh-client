import type {
  AppSettings,
  HostTrustPromptEvent,
  HostTrustRecord,
  SSHConnection,
  SSHSessionState,
} from '../../../shared/types';
import type { IPCResult, SSHConnectResult, SSessionsResult } from '../../../shared/ipc-types';
import { tauriInvoke, type ListenerCleanup } from '../native';

export const nativeSsh = {
  connect: (
    connection: SSHConnection,
    cols?: number,
    rows?: number,
    settings?: AppSettings,
  ): Promise<IPCResult<SSHConnectResult>> => (
    tauriInvoke<SSHConnectResult>('ssh_connect', { connection, cols, rows, settings })
  ),
  disconnect: (connectionId: string): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_disconnect', { connectionId })
  ),
  execute: (connectionId: string, command: string): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_execute', { connectionId, command })
  ),
  executeSync: (connectionId: string, command: string): void => {
    void tauriInvoke<void>('ssh_execute_sync', { connectionId, command });
  },
  getSessions: (): Promise<IPCResult<SSessionsResult>> => (
    tauriInvoke<SSessionsResult>('ssh_get_sessions')
  ),
  resize: (connectionId: string, cols: number, rows: number): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_resize', { connectionId, cols, rows })
  ),
  testConnection: (connection: SSHConnection): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_test_connection', { connection })
  ),
  getHostTrustRecord: (
    host: string,
    port: number,
  ): Promise<IPCResult<{ record: HostTrustRecord | null }>> => (
    tauriInvoke<{ record: HostTrustRecord | null }>('ssh_get_host_trust_record', { host, port })
  ),
  listHostTrustRecords: (): Promise<IPCResult<{ records: HostTrustRecord[] }>> => (
    tauriInvoke<{ records: HostTrustRecord[] }>('ssh_list_host_trust_records')
  ),
  upsertHostTrustRecord: (record: HostTrustRecord): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_upsert_host_trust_record', { record })
  ),
  deleteHostTrustRecord: (host: string, port: number): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_delete_host_trust_record', { host, port })
  ),
  clearHostTrustRecords: (): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_clear_host_trust_records')
  ),
  respondHostTrust: (requestId: string, accepted: boolean): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_respond_host_trust', { requestId, accepted })
  ),
};

export type SshDataListener = (data: {
  connectionId: string;
  data: string;
  type?: string;
  state?: SSHSessionState;
}) => void;

export type HostTrustPromptListener = (data: HostTrustPromptEvent) => void;

export type SshListenerCleanup = ListenerCleanup;
