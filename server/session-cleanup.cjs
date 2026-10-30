/**
 * SSH 会话延迟清理。
 *
 * SSH 会话按 clientId 隔离，WS 断开后延迟释放该 client 的会话：
 * 正常关闭/崩溃/断网后清理，浏览器刷新或网络瞬断时则允许同 clientId
 * 的新 socket 重连并取消清理。
 *
 * 关键竞态：旧 socket 的 close 事件可能晚于新 socket 的 sftp-identify 到达。
 * 因此调度前和定时器触发时都必须再确认该 client 是否已有活跃 socket，
 * 否则会误杀刚重连上来的新会话。
 */

/**
 * 该 clientId 是否仍有打开的 socket。
 *
 * @param {Iterable<any>} sockets 当前 socket 集合
 * @param {string} clientId 客户端标识
 * @returns {boolean} 是否存在活跃 socket
 */
function clientHasLiveSocket(sockets, clientId) {
  if (!clientId) {
    return false;
  }
  for (const socket of sockets) {
    if (!socket || socket.readyState !== socket.OPEN) {
      continue;
    }
    if (socket.clientId === clientId || socket.sshClientId === clientId) {
      return true;
    }
  }
  return false;
}

/**
 * 创建按 clientId 的延迟清理调度器。
 *
 * @param {object} options
 * @param {Iterable<any>} options.sockets 活跃 socket 集合
 * @param {Map<string, any>} options.sessions 会话表
 * @param {(key: string) => void} options.closeSessionByKey 关闭单个会话
 * @param {number} [options.graceMs] 默认宽限毫秒数
 * @param {Function} [options.setTimer] 定时器实现（测试可注入）
 * @param {Function} [options.clearTimer] 取消定时器实现（测试可注入）
 */
function createSessionCleanup({
  sockets,
  sessions,
  closeSessionByKey,
  graceMs = 20 * 1000,
  setTimer = (callback, waitMs) => setTimeout(callback, waitMs),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  const pending = new Map();

  function cancel(clientId) {
    if (!clientId) {
      return;
    }
    const existing = pending.get(clientId);
    if (existing) {
      clearTimer(existing);
      pending.delete(clientId);
    }
  }

  function schedule(clientId, waitMs = graceMs) {
    if (!clientId) {
      return;
    }
    // 旧 socket 的 close 可能晚于新 socket 的 identify：已有活跃 socket 说明是重连，
    // 不能再给新会话排清理。
    if (clientHasLiveSocket(sockets, clientId)) {
      return;
    }
    cancel(clientId);
    const timer = setTimer(() => {
      pending.delete(clientId);
      // 等待期间同 clientId 可能已重连：触发时再确认一次。
      if (clientHasLiveSocket(sockets, clientId)) {
        return;
      }
      for (const [key, session] of sessions) {
        if (session.clientId === clientId) {
          closeSessionByKey(key);
        }
      }
    }, waitMs);
    pending.set(clientId, timer);
  }

  return { schedule, cancel };
}

module.exports = { clientHasLiveSocket, createSessionCleanup };
