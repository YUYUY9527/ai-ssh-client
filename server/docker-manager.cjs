'use strict';

/**
 * Docker 容器管理：复用现有 SSH 会话，在服务器上执行 docker CLI。
 *
 * 不新开端口、不暴露 docker socket、不引入依赖；要求远端已安装 docker CLI
 * 且当前 SSH 用户有权限（通常在 docker 组或可用 sudo）。所有命令参数都经
 * quoteArg 做 POSIX 单引号转义，避免容器名/ID 注入。
 */

const { execCommand } = require('./ssh-exec.cjs');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LOG_TAIL = 300;

function quoteArg(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 安全字符直接透传，其余用 POSIX 单引号包裹（例如 '{{json .}}' 含空格必须引起来）。 */
const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellArg(value) {
  const text = String(value ?? '');
  return SAFE_ARG.test(text) ? text : quoteArg(text);
}

function runDocker(client, args, options = {}) {
  const command = ['docker', ...args.map(shellArg)].join(' ');
  return execCommand(client, command, {
    timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    maxBytes: options.maxBytes,
  });
}

/** 解析 `docker ps --format '{{json .}}'` 的逐行 JSON。 */
function parseContainerLines(output) {
  const containers = [];
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      containers.push({
        id: raw.ID || '',
        name: raw.Names || '',
        image: raw.Image || '',
        command: raw.Command || '',
        state: raw.State || '',
        status: raw.Status || '',
        ports: raw.Ports || '',
        createdAt: raw.CreatedAt || '',
        runningFor: raw.RunningFor || '',
        size: raw.Size || '',
      });
    } catch {
      // 忽略无法解析的行（例如 docker 的提示信息）
    }
  }
  return containers;
}

async function dockerVersion(client) {
  try {
    const result = await runDocker(client, ['version', '--format', '{{.Server.Version}}']);
    const version = String(result.output || '').trim();
    if (result.exitCode === 0 && version) return { available: true, version };
    return { available: false, version: '', error: String(result.stderr || '').trim() };
  } catch (error) {
    return { available: false, version: '', error: error.message };
  }
}

async function listContainers(client) {
  const version = await dockerVersion(client);
  if (!version.available) {
    return { available: false, version: '', error: version.error || 'docker is not available', containers: [] };
  }
  const result = await runDocker(client, ['ps', '-a', '--format', '{{json .}}'], { maxBytes: 2 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    const error = String(result.stderr || '').trim() || 'docker ps failed';
    return { available: false, version: version.version, error, containers: [] };
  }
  return { available: true, version: version.version, containers: parseContainerLines(result.output) };
}

function summarizeInspect(raw) {
  const state = raw?.State || {};
  const config = raw?.Config || {};
  const network = raw?.NetworkSettings || {};
  const ports = [];
  for (const [key, bindings] of Object.entries(network.Ports || {})) {
    if (!bindings || bindings.length === 0) {
      ports.push({ container: key, host: '' });
      continue;
    }
    for (const binding of bindings) {
      ports.push({ container: key, host: `${binding.HostIp || '0.0.0.0'}:${binding.HostPort || ''}` });
    }
  }
  const mounts = (raw?.Mounts || []).map((mount) => ({
    type: mount.Type || '',
    source: mount.Source || '',
    destination: mount.Destination || '',
    mode: mount.Mode || '',
    readOnly: Boolean(mount.RW === false),
  }));
  return {
    id: raw?.Id || '',
    name: String(raw?.Name || '').replace(/^\//, ''),
    image: config.Image || '',
    command: Array.isArray(config.Cmd) ? config.Cmd.join(' ') : String(config.Cmd || ''),
    state: state.Status || '',
    running: Boolean(state.Running),
    exitCode: state.ExitCode ?? null,
    startedAt: state.StartedAt || '',
    finishedAt: state.FinishedAt || '',
    restartCount: raw?.RestartCount ?? 0,
    platform: raw?.Platform || '',
    env: Array.isArray(config.Env) ? config.Env : [],
    ports,
    mounts,
    networks: Object.keys(network.Networks || {}),
  };
}

async function inspectContainer(client, containerId) {
  const result = await runDocker(client, ['inspect', containerId], { maxBytes: 2 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker inspect failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    throw new Error('Unexpected docker inspect output');
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first) throw new Error('Container not found');
  return summarizeInspect(first);
}

async function containerLogs(client, containerId, tail = DEFAULT_LOG_TAIL) {
  const safeTail = Number.isInteger(Number(tail)) && Number(tail) > 0 ? Math.min(Number(tail), 5000) : DEFAULT_LOG_TAIL;
  const result = await runDocker(
    client,
    ['logs', '--tail', String(safeTail), '--timestamps', containerId],
    { maxBytes: 2 * 1024 * 1024, timeoutMs: 20000 },
  );
  if (result.exitCode !== 0 && !result.output) {
    throw new Error(String(result.stderr || '').trim() || 'docker logs failed');
  }
  return { logs: `${result.output || ''}${result.stderr || ''}`, truncated: result.truncated };
}

/**
 * 打开一条 `docker logs -f` 的实时流（SSE 后端用）。
 * 返回 { close }，调用方在客户端断开时关闭底层 ssh 通道。
 */
function openContainerLogStream(client, containerId, tail = DEFAULT_LOG_TAIL, handlers = {}) {
  const safeTail = Number.isInteger(Number(tail)) && Number(tail) > 0 ? Math.min(Number(tail), 5000) : DEFAULT_LOG_TAIL;
  const command = `docker logs -f --tail ${safeTail} --timestamps ${shellArg(containerId)}`;
  let channel = null;
  const stream = client.exec(command, (error, execChannel) => {
    if (error) {
      handlers.onError?.(error);
      return;
    }
    channel = execChannel;
    execChannel.on('data', (chunk) => handlers.onData?.(chunk.toString('utf8')));
    execChannel.stderr.on('data', (chunk) => handlers.onData?.(chunk.toString('utf8')));
    execChannel.on('close', () => handlers.onClose?.());
    execChannel.on('error', (streamError) => handlers.onError?.(streamError));
  });
  stream.on('error', (streamError) => handlers.onError?.(streamError));
  return {
    close() {
      try {
        channel?.close();
      } catch {
        // 已关闭时忽略
      }
      try {
        stream.close();
      } catch {
        // 已关闭时忽略
      }
    },
  };
}

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'kill']);


async function containerAction(client, containerId, action) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Unsupported container action: ${action}`);
  }
  const result = await runDocker(client, [action, containerId]);
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || `docker ${action} failed`);
  }
  return { action, containerId, output: String(result.output || '').trim() };
}

module.exports = {
  quoteArg,
  parseContainerLines,
  dockerVersion,
  listContainers,
  inspectContainer,
  containerLogs,
  openContainerLogStream,
  containerAction,
  ALLOWED_ACTIONS,
};
