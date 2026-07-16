import { useSessionStore } from './useSessionStore';

/**
 * 将服务端输出缓冲合并进本地终端内容。
 * 返回应 append 的增量；无新数据时返回空串。
 */
export function mergeRemoteOutputBuffer(current: string, buffer: string): string {
  if (!buffer) {
    return '';
  }
  if (!current) {
    return buffer;
  }
  // 仅认后缀全量命中，避免短提示符被 includes 误判为“已有”
  if (current.endsWith(buffer)) {
    return '';
  }
  if (buffer.startsWith(current)) {
    return buffer.slice(current.length);
  }

  // 找最大重叠：current 后缀 == buffer 前缀，避免提示符重复
  const max = Math.min(current.length, buffer.length, 4096);
  for (let size = max; size >= 4; size -= 1) {
    if (buffer.startsWith(current.slice(-size))) {
      return buffer.slice(size);
    }
  }

  return buffer;
}

/** 把远端缓冲写入 session store（去重后 append）。 */
export function applyRemoteOutputBuffer(sessionId: string, buffer: string): void {
  if (!sessionId || !buffer) {
    return;
  }
  const current = useSessionStore.getState().outputs[sessionId] || '';
  const delta = mergeRemoteOutputBuffer(current, buffer);
  if (delta) {
    useSessionStore.getState().appendOutput(sessionId, delta);
  }
}
