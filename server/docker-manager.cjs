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
/** docker pull / compose up 可能耗时数分钟，单独给更长的超时。 */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

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

/** 每个 SSH client 缓存是否需要 `sudo -n docker` 提权。 */
const sudoPrefixCache = new WeakMap();

async function resolveDockerPrefix(client) {
  if (client && typeof client === 'object' && sudoPrefixCache.has(client)) {
    return sudoPrefixCache.get(client);
  }
  return ['docker'];
}

async function runDocker(client, args, options = {}) {
  const prefix = await resolveDockerPrefix(client);
  const command = [...prefix, ...args.map(shellArg)].join(' ');
  const result = await execCommand(client, command, {
    timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    maxBytes: options.maxBytes,
  });
  // 若普通 docker 因权限被拒（非 docker 组），自动探测 `sudo -n docker`
  if (
    result.exitCode !== 0
    && prefix.length === 1
    && /permission denied|got permission denied/i.test(String(result.stderr || result.output || ''))
  ) {
    const sudoCmd = ['sudo', '-n', 'docker', ...args.map(shellArg)].join(' ');
    const sudoResult = await execCommand(client, sudoCmd, {
      timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
      maxBytes: options.maxBytes,
    });
    if (sudoResult.exitCode === 0) {
      if (client && typeof client === 'object') sudoPrefixCache.set(client, ['sudo', '-n', 'docker']);
      return sudoResult;
    }
  }
  return result;
}

/** `docker ps --format '{{json .}}'` 的 Labels 是 `k=v,k=v` 字符串；拆成对象。 */
function parseLabelString(text) {
  const labels = {};
  for (const pair of String(text || '').split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    labels[pair.slice(0, index).trim()] = pair.slice(index + 1);
  }
  return labels;
}

/** 解析 `docker ps --format '{{json .}}'` 的逐行 JSON。 */
function parseContainerLines(output) {
  const containers = [];
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      const labels = parseLabelString(raw.Labels);
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
        composeProject: labels['com.docker.compose.project'] || '',
        composeService: labels['com.docker.compose.service'] || '',
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
const ALLOWED_PRUNE_TARGETS = new Set(['containers', 'images']);
const PRUNE_TIMEOUT_MS = 60 * 1000;

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

/**
 * 读取容器的 compose 归属信息（非 compose 容器返回空字段）。
 * 用 inspect 的 Config.Labels 而不是 ps，避免 Labels 字段被截断。
 */
async function containerComposeMeta(client, containerId) {
  const result = await runDocker(client, ['inspect', '--format', '{{json .Config.Labels}}', containerId]);
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker inspect failed');
  }
  let labels = {};
  try {
    labels = JSON.parse(String(result.output || '{}').trim() || '{}') || {};
  } catch {
    throw new Error('Unexpected docker inspect output');
  }
  return {
    project: String(labels['com.docker.compose.project'] || ''),
    service: String(labels['com.docker.compose.service'] || ''),
    workingDir: String(labels['com.docker.compose.project.working_dir'] || ''),
    configFiles: String(labels['com.docker.compose.project.config_files'] || ''),
  };
}

function buildComposeArgs(meta) {
  const composeArgs = ['compose'];
  if (meta.workingDir) composeArgs.push('--project-directory', meta.workingDir);
  const files = meta.configFiles.split(',').map((item) => item.trim()).filter(Boolean);
  for (const file of files) composeArgs.push('-f', file);
  composeArgs.push('-p', meta.project);
  return composeArgs;
}

async function containerImageName(client, containerId) {
  const result = await runDocker(client, ['inspect', '--format', '{{.Config.Image}}', containerId]);
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker inspect failed');
  }
  const image = String(result.output || '').trim();
  if (!image) throw new Error('无法确定容器镜像');
  return image;
}

/**
 * 「更新」容器：compose 容器执行 `docker compose ... pull <service>` + `up -d <service>`；
 * 非 compose 容器只能 `docker pull <image>`（不做自动重建，避免丢失运行参数）。
 */
async function updateContainer(client, containerId) {
  const meta = await containerComposeMeta(client, containerId);
  if (!meta.project || !meta.service) {
    const image = await containerImageName(client, containerId);
    const pull = await runDocker(client, ['pull', image], {
      timeoutMs: UPDATE_TIMEOUT_MS,
      maxBytes: 4 * 1024 * 1024,
    });
    const output = `${pull.output || ''}${pull.stderr || ''}`.trim();
    if (pull.exitCode !== 0) {
      throw new Error(output || `docker pull ${image} failed`);
    }
    return {
      mode: 'pull',
      project: '',
      service: '',
      image,
      output,
      message: '非 compose 容器：已拉取最新镜像，请手动重建容器以使用新镜像。',
    };
  }

  const composeArgs = buildComposeArgs(meta);

  const pull = await runDocker(client, [...composeArgs, 'pull', meta.service], {
    timeoutMs: UPDATE_TIMEOUT_MS,
    maxBytes: 4 * 1024 * 1024,
  });
  const pullOutput = `${pull.output || ''}${pull.stderr || ''}`.trim();
  if (pull.exitCode !== 0) {
    throw new Error(pullOutput || `docker compose pull ${meta.service} failed`);
  }

  const up = await runDocker(client, [...composeArgs, 'up', '-d', meta.service], {
    timeoutMs: UPDATE_TIMEOUT_MS,
    maxBytes: 4 * 1024 * 1024,
  });
  const upOutput = `${up.output || ''}${up.stderr || ''}`.trim();
  if (up.exitCode !== 0) {
    throw new Error(upOutput || `docker compose up -d ${meta.service} failed`);
  }

  return {
    mode: 'compose',
    project: meta.project,
    service: meta.service,
    image: '',
    output: [pullOutput, upOutput].filter(Boolean).join('\n'),
    message: `已更新 ${meta.project}/${meta.service}（pull + up -d）。`,
  };
}

/**
 * 单服务「重建」容器：compose 容器依次执行 stop -> rm -f -> up -d --no-deps，
 * 避免使用 `docker compose down` 误拆同 compose 文件下的其他服务，同时重新读取最新配置与挂载。
 */
async function recreateContainer(client, containerId) {
  const meta = await containerComposeMeta(client, containerId);
  if (!meta.project || !meta.service) {
    throw new Error('非 compose 容器不支持单服务重建');
  }

  const composeArgs = buildComposeArgs(meta);
  const execOptions = { timeoutMs: UPDATE_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 };

  const stop = await runDocker(client, [...composeArgs, 'stop', meta.service], execOptions);
  const stopOutput = `${stop.output || ''}${stop.stderr || ''}`.trim();
  if (stop.exitCode !== 0) {
    throw new Error(stopOutput || `docker compose stop ${meta.service} failed`);
  }

  const rm = await runDocker(client, [...composeArgs, 'rm', '-f', meta.service], execOptions);
  const rmOutput = `${rm.output || ''}${rm.stderr || ''}`.trim();
  if (rm.exitCode !== 0) {
    throw new Error(rmOutput || `docker compose rm -f ${meta.service} failed`);
  }

  const up = await runDocker(client, [...composeArgs, 'up', '-d', '--no-deps', meta.service], execOptions);
  const upOutput = `${up.output || ''}${up.stderr || ''}`.trim();
  if (up.exitCode !== 0) {
    throw new Error(upOutput || `docker compose up -d --no-deps ${meta.service} failed`);
  }

  return {
    project: meta.project,
    service: meta.service,
    output: [stopOutput, rmOutput, upOutput].filter(Boolean).join('\n'),
    message: `已重建 ${meta.project}/${meta.service}（stop + rm -f + up -d --no-deps）。`,
  };
}

/** 删除单个容器（不传 -v，保留数据卷）。 */
async function removeContainer(client, containerId, options = {}) {
  const force = Boolean(options.force);
  const args = force ? ['rm', '-f', containerId] : ['rm', containerId];
  const result = await runDocker(client, args);
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker rm failed');
  }
  return { containerId, force, output: String(result.output || '').trim() };
}

/** 清理已停止容器或悬空镜像。 */
async function pruneDocker(client, target) {
  if (!ALLOWED_PRUNE_TARGETS.has(target)) {
    throw new Error(`Unsupported prune target: ${target}`);
  }
  const args = target === 'containers'
    ? ['container', 'prune', '-f']
    : ['image', 'prune', '-f'];
  const result = await runDocker(client, args, {
    timeoutMs: PRUNE_TIMEOUT_MS,
    maxBytes: 2 * 1024 * 1024,
  });
  const output = `${result.output || ''}${result.stderr || ''}`.trim();
  if (result.exitCode !== 0) {
    throw new Error(output || `docker ${args.join(' ')} failed`);
  }
  const match = output.match(/Total reclaimed space:\s*(.+)/i);
  const reclaimedSpace = match ? match[1].trim() : '';
  return { target, reclaimedSpace, output };
}

/** 采集运行中容器的实时资源统计（CPU / 内存 / 网络 / 磁盘 IO）。 */
async function containerStats(client) {
  const result = await runDocker(client, ['stats', '--no-stream', '--format', '{{json .}}'], {
    timeoutMs: 20000,
    maxBytes: 2 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker stats failed');
  }
  const stats = [];
  for (const line of String(result.output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      stats.push({
        id: raw.ID || raw.Container || '',
        name: raw.Name || '',
        cpuPerc: raw.CPUPerc || '0.00%',
        memUsage: raw.MemUsage || '',
        memPerc: raw.MemPerc || '0.00%',
        netIO: raw.NetIO || '',
        blockIO: raw.BlockIO || '',
        pids: raw.PIDs || '0',
      });
    } catch { /* ignore */ }
  }
  return { stats };
}

/** 列出本地镜像。 */
async function listImages(client) {
  const result = await runDocker(client, ['images', '--format', '{{json .}}'], { maxBytes: 2 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker images failed');
  }
  const images = [];
  for (const line of String(result.output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      images.push({
        id: raw.ID || '',
        repository: raw.Repository || '',
        tag: raw.Tag || '',
        size: raw.Size || '',
        createdSince: raw.CreatedSince || raw.CreatedAt || '',
      });
    } catch { /* ignore */ }
  }
  return { images };
}

async function removeImage(client, imageId, options = {}) {
  const args = options.force ? ['rmi', '-f', imageId] : ['rmi', imageId];
  const result = await runDocker(client, args, { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'docker rmi failed').trim());
  }
  return { imageId, output: String(result.output || '').trim() };
}

/** 列出数据卷。 */
async function listVolumes(client) {
  const result = await runDocker(client, ['volume', 'ls', '--format', '{{json .}}'], { maxBytes: 2 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker volume ls failed');
  }
  const volumes = [];
  for (const line of String(result.output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      volumes.push({
        name: raw.Name || '',
        driver: raw.Driver || '',
        mountpoint: raw.Mountpoint || '',
        scope: raw.Scope || '',
      });
    } catch { /* ignore */ }
  }
  return { volumes };
}

async function removeVolume(client, volumeName) {
  const result = await runDocker(client, ['volume', 'rm', volumeName]);
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'docker volume rm failed').trim());
  }
  return { name: volumeName, output: String(result.output || '').trim() };
}

/** 列出网络。 */
async function listNetworks(client) {
  const result = await runDocker(client, ['network', 'ls', '--format', '{{json .}}'], { maxBytes: 2 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'docker network ls failed');
  }
  const networks = [];
  for (const line of String(result.output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      networks.push({
        id: raw.ID || '',
        name: raw.Name || '',
        driver: raw.Driver || '',
        scope: raw.Scope || '',
      });
    } catch { /* ignore */ }
  }
  return { networks };
}

async function removeNetwork(client, networkId) {
  const result = await runDocker(client, ['network', 'rm', networkId]);
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'docker network rm failed').trim());
  }
  return { id: networkId, output: String(result.output || '').trim() };
}

/** 列出 Docker Compose 项目。 */
async function listComposeProjects(client) {
  const result = await runDocker(client, ['compose', 'ls', '-a', '--format', 'json'], { maxBytes: 2 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    return { projects: [] };
  }
  let parsed = [];
  try {
    const raw = JSON.parse(String(result.output || '[]').trim() || '[]');
    parsed = Array.isArray(raw) ? raw : [];
  } catch {
    parsed = [];
  }
  return {
    projects: parsed.map((item) => ({
      name: String(item.Name || ''),
      status: String(item.Status || ''),
      configFiles: String(item.ConfigFiles || ''),
    })),
  };
}

/** 读取远端 docker-compose.yml 内容。 */
async function readComposeFile(client, configFile) {
  const target = String(configFile || '').split(',')[0].trim();
  if (!target || target.includes('\0')) throw new Error('Invalid compose file path');
  const result = await execCommand(client, `cat -- ${quoteArg(target)}`, { timeoutMs: 15000, maxBytes: 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || 'Failed to read compose file').trim());
  }
  return { path: target, content: result.output || '' };
}

/** 保存修改后的 docker-compose.yml 并执行 docker compose up -d。 */
async function saveComposeAndUp(client, configFile, content, projectName) {
  const target = String(configFile || '').split(',')[0].trim();
  if (!target || target.includes('\0')) throw new Error('Invalid compose file path');
  if (typeof content !== 'string') throw new Error('Compose file content is required');
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const writeRes = await execCommand(
    client,
    `printf '%s' '${b64}' | base64 -d > ${quoteArg(target)}`,
    { timeoutMs: 15000 },
  );
  if (writeRes.exitCode !== 0) {
    throw new Error(String(writeRes.stderr || 'Failed to write compose file').trim());
  }
  const args = ['compose', '-f', target];
  if (projectName) args.push('-p', projectName);
  args.push('up', '-d');
  const upRes = await runDocker(client, args, { timeoutMs: UPDATE_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 });
  const output = `${upRes.output || ''}${upRes.stderr || ''}`.trim();
  if (upRes.exitCode !== 0) {
    throw new Error(output || 'docker compose up -d failed');
  }
  return { path: target, output };
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
  updateContainer,
  recreateContainer,
  removeContainer,
  pruneDocker,
  containerStats,
  listImages,
  removeImage,
  listVolumes,
  removeVolume,
  listNetworks,
  removeNetwork,
  listComposeProjects,
  readComposeFile,
  saveComposeAndUp,
  ALLOWED_ACTIONS,
  ALLOWED_PRUNE_TARGETS,
};
