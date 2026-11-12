import { useState } from 'react';
import { Container } from 'lucide-react';

import { DockerPanel } from './DockerPanel';

interface DockerButtonProps {
  connectionId: string | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** 容器管理入口：仅已有报文连接且服务端支持 docker 相关 API 时出现。 */
export function DockerButton({ connectionId, translate }: DockerButtonProps) {
  const [open, setOpen] = useState(false);

  if (!connectionId || typeof window.electronAPI?.listDockerContainers !== 'function') return null;

  return (
    <>
      <button
        type="button"
        className="terminal-control"
        title={translate('terminal.docker.title')}
        onClick={() => setOpen(true)}
      >
        <Container className="h-4 w-4" />
      </button>
      {open ? <DockerPanel connectionId={connectionId} translate={translate} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
