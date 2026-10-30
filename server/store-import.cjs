'use strict';

/**
 * 备份导入的规范化与应用（纯函数，便于单测）。
 *
 * 关键语义：必须区分“字段缺失”和“字段存在但为空数组”。
 *  - 缺失 -> normalize 返回 undefined；overwrite 时保持原数据不变。
 *  - 显式 [] -> 返回 []；overwrite 时必须用它清空集合（这正是历史 bug：旧实现
 *    用 `length > 0` 判断，显式空的备份无法清掉旧的 provider/快捷命令/信任记录）。
 */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 返回第一个 !== undefined 的别名值；全部缺失时返回 undefined。 */
function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 缺失保持 undefined；存在则归一化为数组。 */
function asOptionalArray(value) {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [];
}

function normalizeConnections(input) {
  return asArray(input).map((connection) => ({
    id: String(connection.id || Date.now()),
    name: String(connection.name || connection.host || 'SSH Connection'),
    host: String(connection.host || ''),
    port: Number(connection.port || 22),
    username: String(connection.username || ''),
    password: connection.password || undefined,
    privateKey: connection.privateKey || connection.private_key || undefined,
    passphrase: connection.passphrase || undefined,
  })).filter((connection) => connection.host && connection.username);
}

function normalizeImportData(input) {
  const data = input?.data || input || {};

  return {
    connections: normalizeConnections(
      firstDefined(data.connections, data.sshConnections, data.ssh_connections),
    ),
    settings: data.settings,
    commandHistory: asOptionalArray(firstDefined(data.commandHistory, data.command_history)),
    quickCommands: asOptionalArray(firstDefined(data.quickCommands, data.quick_commands)),
    quickCommandGroups: asOptionalArray(firstDefined(data.quickCommandGroups, data.quick_command_groups)),
    aiProviders: asOptionalArray(firstDefined(data.aiProviders, data.ai_providers)),
    hostTrustRecords: asOptionalArray(firstDefined(data.hostTrustRecords, data.host_trust_records)),
  };
}

/** 按 id 合并：导入项覆盖同 id 的旧项，其余保留顺序。 */
function mergeById(current, incoming) {
  const currentList = Array.isArray(current) ? current : [];
  return [
    ...currentList.filter((item) => !incoming.some((next) => next.id === item.id)),
    ...incoming,
  ];
}

/** id 集合字段的应用：merge 为追加覆盖，overwrite 直接替换（含显式空数组）。 */
function applyIdCollection(store, key, incoming, merge) {
  if (incoming === undefined) {
    // 字段缺失：两种模式都不动现有数据
    return;
  }
  if (merge) {
    if (incoming.length === 0) return; // 追加模式下的空数组无意义
    store[key] = mergeById(store[key], incoming);
    return;
  }
  store[key] = incoming;
}

/**
 * 把规范化后的导入数据应用到 store（原地修改并返回）。
 * @param {object} store 当前 store
 * @param {object} imported normalizeImportData 的结果
 * @param {boolean} merge true=合并（缺省），false=覆盖
 * @param {object} defaultSettings 兜底设置
 */
function applyImportData(store, imported, merge, defaultSettings = {}) {
  // 连接：沿用既有语义，覆盖模式下始终以导入结果替换（缺失即清空）。
  store.connections = merge
    ? mergeById(store.connections, imported.connections || [])
    : (imported.connections || []);

  if (imported.settings && Object.keys(imported.settings).length > 0) {
    store.settings = { ...defaultSettings, ...store.settings, ...imported.settings };
  }

  if (imported.commandHistory !== undefined) {
    if (merge) {
      if (imported.commandHistory.length > 0) {
        store.commandHistory = [...imported.commandHistory, ...(store.commandHistory || [])].slice(0, 500);
      }
    } else {
      store.commandHistory = imported.commandHistory.slice(0, 500);
    }
  }

  applyIdCollection(store, 'quickCommands', imported.quickCommands, merge);
  applyIdCollection(store, 'quickCommandGroups', imported.quickCommandGroups, merge);
  applyIdCollection(store, 'aiProviders', imported.aiProviders, merge);

  if (imported.hostTrustRecords !== undefined) {
    if (merge) {
      if (imported.hostTrustRecords.length > 0) {
        store.hostTrustRecords = [
          ...(store.hostTrustRecords || []).filter((item) => (
            !imported.hostTrustRecords.some((next) => (
              next.host === item.host && Number(next.port) === Number(item.port)
            ))
          )),
          ...imported.hostTrustRecords,
        ];
      }
    } else {
      store.hostTrustRecords = imported.hostTrustRecords;
    }
  }

  return store;
}

/** 导入结果计数，供接口返回 summary 使用。 */
function importSummary(imported) {
  return {
    connections: (imported.connections || []).length,
    aiProviders: imported.aiProviders?.length ?? 0,
    settings: imported.settings ? 1 : 0,
    quickCommands: imported.quickCommands?.length ?? 0,
    quickCommandGroups: imported.quickCommandGroups?.length ?? 0,
    hostTrustRecords: imported.hostTrustRecords?.length ?? 0,
  };
}

module.exports = {
  normalizeImportData,
  applyImportData,
  importSummary,
};
