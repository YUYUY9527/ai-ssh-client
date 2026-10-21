const fs = require('node:fs');
const path = require('node:path');

/**
 * MCP 服务端策略文件：`data/mcp-policy.json`。
 *
 * 这个文件是「按连接放开安全边界」的唯一入口，由 Web 设置页编辑，
 * 由 MCP 进程启动时读取。这里的校验同时被网关和 MCP 进程使用，
 * 避免「页面允许保存、MCP 启动时却解析失败」的两套规则。
 *
 * 设计约束：
 * - 只支持 read-only / exec 两种模式，没有「关闭全部护栏」的开关；
 * - 例外命令必须精确匹配整条命令，不接受正则，避免 `.*` 一键失守；
 * - 未知字段直接报错，避免拼写错误被静默忽略后误以为策略已生效。
 */

const POLICY_FILENAME = 'mcp-policy.json';
const MAX_POLICY_FILE_BYTES = 1024 * 1024;

const MODES = ['read-only', 'exec'];

const LIMIT_BOUNDS = Object.freeze({
  maxOutputBytes: { default: 256 * 1024, min: 1024, max: 4 * 1024 * 1024 },
  execTimeoutMs: { default: 30_000, min: 1000, max: 300_000 },
  maxCommandChars: { default: 8_192, min: 128, max: 65_536 },
  maxReadBytes: { default: 256 * 1024, min: 1024, max: 1024 * 1024 },
});

const POLICY_KEYS = ['defaultMode', 'trustOnFirstUse', 'connections', 'commands', 'limits', 'audit'];
const COMMAND_KEYS = ['deny', 'exceptions'];
const AUDIT_KEYS = ['enabled'];
const LIMIT_KEYS = Object.keys(LIMIT_BOUNDS);

/** 与策略行为相关、且会被环境变量覆盖的变量名，供 UI 提示。 */
const POLICY_ENV_VARS = [
  'MCP_ALLOW_EXEC',
  'MCP_TRUST_ON_FIRST_USE',
  'MCP_MAX_OUTPUT_BYTES',
  'MCP_EXEC_TIMEOUT_MS',
  'MCP_MAX_COMMAND_CHARS',
  'MCP_MAX_READ_BYTES',
  'MCP_AUDIT',
];

function policyError(message) {
  const error = new Error(message);
  error.code = 'invalid-mcp-policy';
  return error;
}

function createDefaultPolicy() {
  const limits = {};
  for (const [key, bounds] of Object.entries(LIMIT_BOUNDS)) {
    limits[key] = bounds.default;
  }
  return {
    defaultMode: 'read-only',
    trustOnFirstUse: false,
    connections: {},
    commands: { deny: [], exceptions: [] },
    limits,
    audit: { enabled: true },
  };
}

/** 只读用途的默认值快照，避免调用方改到共享对象。 */
const DEFAULT_POLICY = createDefaultPolicy();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isPlainObject(value)) {
    throw policyError(`${label} 必须是 JSON 对象`);
  }
}

function assertKnownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw policyError(`${label} 包含未知字段 "${key}"（允许：${allowed.join('、')}）`);
    }
  }
}

function validateMode(value, label) {
  if (!MODES.includes(value)) {
    throw policyError(`${label} 必须是 "read-only" 或 "exec"`);
  }
  return value;
}

function validateBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw policyError(`${label} 必须是 true 或 false`);
  }
  return value;
}

function validateStringArray(value, label, { maxItems = 500, maxLength = 8_192 } = {}) {
  if (!Array.isArray(value)) {
    throw policyError(`${label} 必须是字符串数组`);
  }
  if (value.length > maxItems) {
    throw policyError(`${label} 最多允许 ${maxItems} 项`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw policyError(`${label}[${index}] 必须是非空字符串`);
    }
    const trimmed = item.trim();
    if (trimmed.length > maxLength) {
      throw policyError(`${label}[${index}] 超过 ${maxLength} 个字符`);
    }
    return trimmed;
  });
}

function validateLimit(value, label, bounds) {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw policyError(`${label} 必须是 ${bounds.min}..${bounds.max} 之间的整数`);
  }
  return value;
}

/**
 * 把任意输入规范化为完整策略对象；缺省字段用默认值补齐。
 * 校验失败抛 `invalid-mcp-policy`，调用方不得吞掉。
 */
function normalizePolicy(input) {
  const source = input === undefined || input === null ? {} : input;
  assertObject(source, 'MCP 策略');
  assertKnownKeys(source, POLICY_KEYS, 'MCP 策略');

  const policy = createDefaultPolicy();

  if (source.defaultMode !== undefined) {
    policy.defaultMode = validateMode(source.defaultMode, 'defaultMode');
  }
  if (source.trustOnFirstUse !== undefined) {
    policy.trustOnFirstUse = validateBoolean(source.trustOnFirstUse, 'trustOnFirstUse');
  }

  if (source.connections !== undefined) {
    assertObject(source.connections, 'connections');
    const entries = Object.entries(source.connections);
    if (entries.length > 500) {
      throw policyError('connections 最多允许 500 项');
    }
    for (const [key, mode] of entries) {
      const connectionKey = String(key).trim();
      if (!connectionKey) {
        throw policyError('connections 的键不能为空');
      }
      if (connectionKey.length > 200) {
        throw policyError(`connections 的键 "${connectionKey.slice(0, 40)}…" 过长`);
      }
      policy.connections[connectionKey] = validateMode(mode, `connections["${connectionKey}"]`);
    }
  }

  if (source.commands !== undefined) {
    assertObject(source.commands, 'commands');
    assertKnownKeys(source.commands, COMMAND_KEYS, 'commands');
    if (source.commands.deny !== undefined) {
      const deny = validateStringArray(source.commands.deny, 'commands.deny', { maxLength: 2_000 });
      deny.forEach((pattern, index) => {
        try {
          new RegExp(pattern, 'i');
        } catch (error) {
          throw policyError(`commands.deny[${index}] 不是合法正则：${error.message}`);
        }
      });
      policy.commands.deny = deny;
    }
    if (source.commands.exceptions !== undefined) {
      const exceptions = validateStringArray(
        source.commands.exceptions,
        'commands.exceptions',
        { maxLength: 8_192 },
      );
      policy.commands.exceptions = [...new Set(exceptions)];
    }
  }

  if (source.limits !== undefined) {
    assertObject(source.limits, 'limits');
    assertKnownKeys(source.limits, LIMIT_KEYS, 'limits');
    for (const key of LIMIT_KEYS) {
      if (source.limits[key] !== undefined) {
        policy.limits[key] = validateLimit(source.limits[key], `limits.${key}`, LIMIT_BOUNDS[key]);
      }
    }
  }

  if (source.audit !== undefined) {
    assertObject(source.audit, 'audit');
    assertKnownKeys(source.audit, AUDIT_KEYS, 'audit');
    if (source.audit.enabled !== undefined) {
      policy.audit.enabled = validateBoolean(source.audit.enabled, 'audit.enabled');
    }
  }

  return policy;
}

/** 解析策略文件路径：`MCP_POLICY_FILE` 可覆盖，相对路径按数据目录解析。 */
function resolvePolicyPath({ dataDir, env = process.env } = {}) {
  const configured = String(env.MCP_POLICY_FILE || '').trim();
  if (!configured) {
    return path.join(path.resolve(dataDir || '.'), POLICY_FILENAME);
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(dataDir || '.', configured);
}

/**
 * 读取策略文件。文件不存在 → 默认策略（只读）；存在但损坏 → 抛错。
 * 不静默降级：否则用户以为已放开，实际 MCP 仍按只读运行。
 */
function readPolicyFile({ dataDir, env = process.env } = {}) {
  const policyPath = resolvePolicyPath({ dataDir, env });
  let stat;
  try {
    stat = fs.statSync(policyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: policyPath,
        exists: false,
        policy: createDefaultPolicy(),
      };
    }
    throw policyError(`无法读取 MCP 策略文件 ${policyPath}：${error.message}`);
  }

  if (!stat.isFile()) {
    throw policyError(`MCP 策略路径不是文件：${policyPath}`);
  }
  if (stat.size > MAX_POLICY_FILE_BYTES) {
    throw policyError(`MCP 策略文件超过 ${MAX_POLICY_FILE_BYTES} 字节：${policyPath}`);
  }

  let text;
  try {
    text = fs.readFileSync(policyPath, 'utf8');
  } catch (error) {
    throw policyError(`无法读取 MCP 策略文件 ${policyPath}：${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw policyError(`MCP 策略文件不是合法 JSON（${policyPath}）：${error.message}`);
  }

  try {
    return {
      path: policyPath,
      exists: true,
      policy: normalizePolicy(parsed),
    };
  } catch (error) {
    throw policyError(`${policyPath}：${error.message}`);
  }
}

/** 校验并原子写入策略文件。 */
function writePolicyFile({ dataDir, env = process.env, policy } = {}) {
  if (policy === undefined || policy === null) {
    throw policyError('写入 MCP 策略时必须提供 policy 对象');
  }
  const normalized = normalizePolicy(policy);
  const policyPath = resolvePolicyPath({ dataDir, env });
  const directory = path.dirname(policyPath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = `${policyPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tempPath, policyPath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw policyError(`无法写入 MCP 策略文件 ${policyPath}：${error.message}`);
  }

  return {
    path: policyPath,
    exists: true,
    policy: normalized,
  };
}

/** 列出会覆盖策略文件的环境变量（UI 用来提示「保存了但被 env 覆盖」）。 */
function overriddenEnvVars(env = process.env) {
  return POLICY_ENV_VARS.filter((name) => (
    env[name] !== undefined && String(env[name]).trim() !== ''
  ));
}

module.exports = {
  POLICY_FILENAME,
  MAX_POLICY_FILE_BYTES,
  MODES,
  LIMIT_BOUNDS,
  POLICY_ENV_VARS,
  DEFAULT_POLICY,
  createDefaultPolicy,
  normalizePolicy,
  resolvePolicyPath,
  readPolicyFile,
  writePolicyFile,
  overriddenEnvVars,
};