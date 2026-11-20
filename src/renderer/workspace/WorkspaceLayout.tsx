import type { ReactNode } from 'react';

interface WorkspaceLayoutProps {
  children: ReactNode;
  sidebar?: ReactNode;
  /** 会话级弹层挂载宿主：渲染在 .app-main 内，不遮挡顶栏与会话标签栏。 */
  overlays?: ReactNode;
}

/** Layout for the active session area and optional session-bound sidebars. */
export function WorkspaceLayout({ children, sidebar, overlays }: WorkspaceLayoutProps) {
  return (
    <div className="app-main">
      <div className="flex min-w-0 flex-1">
        {/* SFTP 从左侧展开，终端区域在右侧 */}
        {sidebar}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
      {overlays}
    </div>
  );
}
