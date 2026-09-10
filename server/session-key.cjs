/**
 * 会话/执行的复合键：`{connectionId}::{clientId}`。
 *
 * 同一台主机可能被多个客户端（不同浏览器标签页、不同设备）同时连接，
 * 因此 connectionId 单独不足以确定归属——必须加上 clientId 才能隔离。
 * SSH 会话表与在途 agent 执行表共用这一个键格式，避免两处定义漂移。
 */
function sessionKeyOf(connectionId, clientId) {
  return `${connectionId}::${clientId || ''}`;
}

/**
 * 从一组复合键里挑出属于指定客户端的键。
 *
 * 用于"暂停"这类面向整个客户端的操作：桌面端对应 `cancel_all_execs()`。
 * 必须按 `::clientId` 后缀精确匹配，否则连同一主机的其他客户端会被误伤。
 */
function clientKeysOf(keys, clientId) {
  const suffix = `::${clientId || ''}`;
  return keys.filter((key) => typeof key === 'string' && key.endsWith(suffix));
}

module.exports = { sessionKeyOf, clientKeysOf };
