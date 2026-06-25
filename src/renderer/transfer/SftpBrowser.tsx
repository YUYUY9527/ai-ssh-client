import { FileTransfer } from '../components/FileTransfer';

interface SftpBrowserProps {
  connectionId: string;
  onClose?: () => void;
}

/** Session-bound SFTP browser surface. */
export function SftpBrowser({ connectionId, onClose }: SftpBrowserProps) {
  return (
    <FileTransfer
      connectionId={connectionId}
      onClose={onClose}
    />
  );
}
