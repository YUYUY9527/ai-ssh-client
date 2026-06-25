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
        <div className="relative flex min-w-0 flex-1 flex-col">
          {children}
        </div>
        {sidebar}
      </div>
    </div>
  );
}
