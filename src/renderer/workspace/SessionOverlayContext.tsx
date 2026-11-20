import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface SessionOverlayContextValue {
  /** 会话专属蒙层挂载容器（位于 .app-main 内，不遮挡顶栏与会话标签栏）。 */
  container: HTMLElement | null;
  /** 当前会话是否处于激活可见态；非激活会话的弹窗会隐藏并暂停快捷键拦截。 */
  isActive: boolean;
  /** 所属会话 id（null 表示全局上下文）。 */
  sessionId: string | null;
}

const DEFAULT_SESSION_OVERLAY: SessionOverlayContextValue = {
  container: null,
  isActive: true,
  sessionId: null,
};

const SessionOverlayContext = createContext<SessionOverlayContextValue>(DEFAULT_SESSION_OVERLAY);

interface SessionOverlayProviderProps extends SessionOverlayContextValue {
  children: ReactNode;
}

/** 为会话子树提供隔离的弹层挂载点与激活状态。 */
export function SessionOverlayProvider({
  container,
  isActive,
  sessionId,
  children,
}: SessionOverlayProviderProps) {
  const value = useMemo(
    () => ({ container, isActive, sessionId }),
    [container, isActive, sessionId],
  );
  return (
    <SessionOverlayContext.Provider value={value}>
      {children}
    </SessionOverlayContext.Provider>
  );
}

/** 读取当前组件所属的会话弹层上下文；未包裹在会话内时回退为全局模式。 */
export function useSessionOverlay(): SessionOverlayContextValue {
  return useContext(SessionOverlayContext);
}
