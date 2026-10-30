/**
 * 在途 agent 执行的取消句柄注册表辅助函数。
 *
 * 每个 run 结束（finish）时都要清理自己登记的取消句柄。但如果同一个 execKey
 * 已经被后一次 run 覆盖成新的句柄，旧 run 迟到的 finish 只能删除自己那把，
 * 否则会把新 run 的句柄删掉，导致新 run 无法被取消（见 issue #3）。
 */

/**
 * 仅当 key 当前映射的句柄与 handle 严格相等时才删除该项。
 *
 * @param {Map<unknown, unknown>} map 注册表
 * @param {unknown} key 执行键
 * @param {unknown} handle 本次 run 自己创建的句柄
 * @returns {boolean} 是否真的删除了该项
 */
function deleteIfCurrent(map, key, handle) {
  if (map.get(key) === handle) {
    map.delete(key);
    return true;
  }
  return false;
}

module.exports = { deleteIfCurrent };
