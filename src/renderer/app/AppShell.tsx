import type { ReactNode } from 'react';

interface AppShellProps {
  assistant: ReactNode;
  footer: ReactNode;
  header: ReactNode;
  modals: ReactNode;
  tabs: ReactNode;
  toasts: ReactNode;
  workspace: ReactNode;
}

/** Top-level application shell that composes app chrome and workspace regions. */
export function AppShell({
  assistant,
  footer,
  header,
  modals,
  tabs,
  toasts,
  workspace,
}: AppShellProps) {
  return (
    <div className="app-shell">
      {header}
      {tabs}
      {workspace}
      {assistant}
      {toasts}
      {footer}
      {modals}
    </div>
  );
}
