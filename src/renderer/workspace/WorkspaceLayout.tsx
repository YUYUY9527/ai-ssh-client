import type { ReactNode } from 'react';

interface WorkspaceLayoutProps {
  children: ReactNode;
  sidebar?: ReactNode;
}

/** Layout for the active session area and optional session-bound sidebars. */
export function WorkspaceLayout({ children, sidebar }: WorkspaceLayoutProps) {
  return (
    <div className="app-main">
      <div className="flex min-w-0 flex-1">
        {/* SFTP 从左侧展开，终端区域在右侧 */}
        {sidebar}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
