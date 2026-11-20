import { Container } from 'lucide-react';

import { useWorkspaceStore } from '../../workspace/useWorkspaceStore';

interface DockerButtonProps {
  connectionId: string | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** 容器管理入口：按会话绑定状态（状态存于 workspace store，切标签保留、关闭标签自动清理）。 */
export function DockerButton({ connectionId, translate }: DockerButtonProps) {
  const open = useWorkspaceStore((state) => Boolean(connectionId && state.dockerPanelBySession[connectionId]));
  const setDockerPanelOpen = useWorkspaceStore((state) => state.setDockerPanelOpen);

  if (!connectionId || typeof window.electronAPI?.listDockerContainers !== 'function') return null;

  return (
    <button
      type="button"
      className={`terminal-control ${open ? 'terminal-control-active' : ''}`}
      title={translate('terminal.docker.title')}
      aria-pressed={open}
      onClick={() => setDockerPanelOpen(connectionId, !open)}
    >
      <Container className="h-4 w-4" />
    </button>
  );
}
