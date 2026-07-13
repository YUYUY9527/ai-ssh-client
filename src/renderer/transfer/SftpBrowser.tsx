import { FileTransfer } from '../components/FileTransfer';

interface SftpBrowserProps {
  connectionId: string;
  isLive: boolean;
  onClose?: () => void;
}

/** Session-bound SFTP browser surface. */
export function SftpBrowser({ connectionId, isLive, onClose }: SftpBrowserProps) {
  return (
    <FileTransfer
      connectionId={connectionId}
      isLive={isLive}
      onClose={onClose}
    />
  );
}
