'use strict';

/**
 * SFTP 进阶文件操作（基于 SSH exec + 严格 POSIX 单引号转义）：
 * - 远端打包压缩（.tar.gz / .zip）与解压（.tar.gz / .tgz / .tar / .zip）
 * - 同服务器复制（cp -a）与移动（mv）
 * - 创建符号链接（ln -s）
 * - 修改文件属主/属组（chown [-R]）
 */

const posixPath = require('node:path').posix;
const { execCommand } = require('./ssh-exec.cjs');

function quoteArg(value) {
  const text = String(value ?? '');
  if (text.includes('\0')) throw new Error('Path contains NUL byte');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function requireValidPath(value, label = 'path') {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.includes('\0')) throw new Error(`${label} contains NUL byte`);
  return text;
}

const STREAM_OP_TIMEOUT_MS = 10 * 60 * 1000;
const TAR_PRECOUNT_MAX_BYTES = 30 * 1024 * 1024;
const PROGRESS_THROTTLE_MS = 120;

/** 通过 ssh2 exec 流式读取输出行（用于实时上报压缩/解压进度），同时收集 stderr 便于报错。 */
function execStreamingLines(client, command, { timeoutMs = STREAM_OP_TIMEOUT_MS, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuf = '';
    let stderr = '';
    let timer = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    client.exec(command, (error, stream) => {
      if (error) {
        finish(error);
        return;
      }

      timer = setTimeout(() => {
        try { stream.close?.(); } catch { /* ignore */ }
        finish(new Error('Operation timed out'));
      }, timeoutMs);

      const handleChunk = (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        let idx = stdoutBuf.indexOf('\n');
        while (idx !== -1) {
          const line = stdoutBuf.slice(0, idx).replace(/\r$/, '').trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line && typeof onLine === 'function') {
            onLine(line);
          }
          idx = stdoutBuf.indexOf('\n');
        }
      };

      stream.on('data', handleChunk);
      stream.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (stderr.length < 32 * 1024) {
          stderr += text;
        }
      });
      stream.on('error', (streamErr) => finish(streamErr));
      stream.on('close', (code) => {
        const tail = stdoutBuf.replace(/\r$/, '').trim();
        if (tail && typeof onLine === 'function') {
          onLine(tail);
        }
        finish(null, { exitCode: typeof code === 'number' ? code : 0, stderr });
      });
    });
  });
}

function parsePositiveInt(text) {
  const match = String(text || '').trim().match(/(\d+)/);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function cleanVerboseLine(line, format) {
  let clean = line;
  if (format === 'zip') {
    const match = clean.match(/^(?:adding|updating|inflating|extracting|creating):\s+(.+?)(?:\s+\([^)]*\))?$/i);
    if (!match) return null;
    clean = match[1].trim();
  }
  return clean || null;
}

/** 打包选中的远端路径为 .tar.gz 或 .zip（提供 onProgress 时实时推送文件数与百分比）。 */
async function archiveRemoteItems(client, { baseDir, names, archiveName, format = 'tar.gz', onProgress }) {
  const dir = requireValidPath(baseDir, 'baseDir');
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('At least one item is required');
  }
  const cleanNames = names.map((item) => {
    const name = requireValidPath(item, 'item');
    if (name.includes('/') || name === '..' || name === '.') {
      throw new Error(`Invalid archive entry name: ${name}`);
    }
    return name;
  });
  const ext = format === 'zip' ? '.zip' : '.tar.gz';
  const rawArchive = String(archiveName || `${cleanNames[0]}${ext}`).trim();
  const safeArchive = rawArchive.endsWith(ext) ? rawArchive : `${rawArchive}${ext}`;
  const outPath = posixPath.isAbsolute(safeArchive) ? safeArchive : posixPath.join(dir, safeArchive);

  if (typeof onProgress !== 'function') {
    const cmd = format === 'zip'
      ? `cd ${quoteArg(dir)} && zip -rq ${quoteArg(outPath)} -- ${cleanNames.map(quoteArg).join(' ')}`
      : `tar -czf ${quoteArg(outPath)} -C ${quoteArg(dir)} -- ${cleanNames.map(quoteArg).join(' ')}`;

    const result = await execCommand(client, cmd, { timeoutMs: 120000 });
    if (result.exitCode !== 0) {
      throw new Error(String(result.stderr || result.output || 'Archive failed').trim());
    }
    return { archivePath: outPath, format, count: cleanNames.length };
  }

  onProgress({ phase: 'counting', percent: 0, processedFiles: 0, totalFiles: null });
  let totalFiles = null;
  try {
    const countCmd = `cd ${quoteArg(dir)} && find ${cleanNames.map(quoteArg).join(' ')} 2>/dev/null | wc -l`;
    const countRes = await execCommand(client, countCmd, { timeoutMs: 8000 });
    if (countRes.exitCode === 0) {
      totalFiles = parsePositiveInt(countRes.output);
    }
  } catch {
    totalFiles = null;
  }

  let processedFiles = 0;
  let lastEmitAt = 0;
  const emitRunning = (currentFile, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_THROTTLE_MS) return;
    lastEmitAt = now;
    const percent = totalFiles ? Math.min(99, Math.round((processedFiles / totalFiles) * 100)) : null;
    onProgress({ phase: 'running', percent, processedFiles, totalFiles, currentFile });
  };

  emitRunning('', true);

  const verboseCmd = format === 'zip'
    ? `cd ${quoteArg(dir)} && zip -r ${quoteArg(outPath)} -- ${cleanNames.map(quoteArg).join(' ')}`
    : `tar -czvf ${quoteArg(outPath)} -C ${quoteArg(dir)} -- ${cleanNames.map(quoteArg).join(' ')}`;

  const result = await execStreamingLines(client, verboseCmd, {
    timeoutMs: STREAM_OP_TIMEOUT_MS,
    onLine: (line) => {
      const file = cleanVerboseLine(line, format);
      if (!file) return;
      processedFiles += 1;
      emitRunning(file);
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || 'Archive failed').trim());
  }

  onProgress({
    phase: 'done',
    percent: 100,
    processedFiles,
    totalFiles: totalFiles || processedFiles,
  });
  return { archivePath: outPath, format, count: cleanNames.length };
}

/** 解压远端压缩包（.tar.gz / .tgz / .tar / .tar.bz2 / .tar.xz / .zip）到指定目录（支持流式进度）。 */
async function extractRemoteArchive(client, { archivePath, destinationDir, onProgress }) {
  const src = requireValidPath(archivePath, 'archivePath');
  const dest = requireValidPath(destinationDir || posixPath.dirname(src), 'destinationDir');
  const lower = src.toLowerCase();

  const isZip = lower.endsWith('.zip');
  const isTarGz = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  const isTarBz2 = lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2');
  const isTarXz = lower.endsWith('.tar.xz') || lower.endsWith('.txz');
  const isPlainTar = lower.endsWith('.tar');

  if (!isZip && !isTarGz && !isTarBz2 && !isTarXz && !isPlainTar) {
    throw new Error(`Unsupported archive format: ${posixPath.basename(src)}`);
  }

  if (typeof onProgress !== 'function') {
    let cmd;
    if (isZip) {
      cmd = `mkdir -p ${quoteArg(dest)} && unzip -qo ${quoteArg(src)} -d ${quoteArg(dest)}`;
    } else if (isTarGz) {
      // 兼容实际未经过 gzip 压缩或其它压缩格式但命名为 .tar.gz 的包：-xzf 失败时自动回退 tar -xf 自动识别
      cmd = `mkdir -p ${quoteArg(dest)} && (tar -xzf ${quoteArg(src)} -C ${quoteArg(dest)} 2>/dev/null || tar -xf ${quoteArg(src)} -C ${quoteArg(dest)})`;
    } else if (isTarBz2) {
      cmd = `mkdir -p ${quoteArg(dest)} && (tar -xjf ${quoteArg(src)} -C ${quoteArg(dest)} 2>/dev/null || tar -xf ${quoteArg(src)} -C ${quoteArg(dest)})`;
    } else if (isTarXz) {
      cmd = `mkdir -p ${quoteArg(dest)} && (tar -xJf ${quoteArg(src)} -C ${quoteArg(dest)} 2>/dev/null || tar -xf ${quoteArg(src)} -C ${quoteArg(dest)})`;
    } else {
      cmd = `mkdir -p ${quoteArg(dest)} && tar -xf ${quoteArg(src)} -C ${quoteArg(dest)}`;
    }

    const result = await execCommand(client, cmd, { timeoutMs: 120000 });
    if (result.exitCode !== 0) {
      throw new Error(String(result.stderr || result.output || 'Extract failed').trim());
    }
    return { archivePath: src, destinationDir: dest };
  }

  onProgress({ phase: 'counting', percent: 0, processedFiles: 0, totalFiles: null });
  let totalFiles = null;
  try {
    if (isZip) {
      const countRes = await execCommand(client, `unzip -Z1 ${quoteArg(src)} 2>/dev/null | wc -l`, { timeoutMs: 8000 });
      if (countRes.exitCode === 0) totalFiles = parsePositiveInt(countRes.output);
    } else {
      // 中小体积压缩包或未压缩 tar 先快速统计条目数以显示精确百分比；大包跳过预扫描直接解压避免双倍耗时
      const sizeRes = await execCommand(
        client,
        `stat -c %s ${quoteArg(src)} 2>/dev/null || stat -f %z ${quoteArg(src)} 2>/dev/null`,
        { timeoutMs: 5000 },
      );
      const bytes = parsePositiveInt(sizeRes.output);
      if (isPlainTar || (bytes !== null && bytes <= TAR_PRECOUNT_MAX_BYTES)) {
        const listFlag = isTarGz ? '-tzf' : isTarBz2 ? '-tjf' : isTarXz ? '-tJf' : '-tf';
        const countCmd = isPlainTar
          ? `tar -tf ${quoteArg(src)} 2>/dev/null | wc -l`
          : `(tar ${listFlag} ${quoteArg(src)} 2>/dev/null || tar -tf ${quoteArg(src)} 2>/dev/null) | wc -l`;
        const countRes = await execCommand(client, countCmd, { timeoutMs: 8000 });
        if (countRes.exitCode === 0) totalFiles = parsePositiveInt(countRes.output);
      }
    }
  } catch {
    totalFiles = null;
  }

  let processedFiles = 0;
  let lastEmitAt = 0;
  const emitRunning = (currentFile, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_THROTTLE_MS) return;
    lastEmitAt = now;
    const percent = totalFiles ? Math.min(99, Math.round((processedFiles / totalFiles) * 100)) : null;
    onProgress({ phase: 'running', percent, processedFiles, totalFiles, currentFile });
  };

  emitRunning('', true);

  let verboseCmd;
  if (isZip) {
    verboseCmd = `mkdir -p ${quoteArg(dest)} && unzip -o ${quoteArg(src)} -d ${quoteArg(dest)}`;
  } else if (isTarGz) {
    verboseCmd = `mkdir -p ${quoteArg(dest)} && (tar -xzvf ${quoteArg(src)} -C ${quoteArg(dest)} 2>/dev/null || tar -xvf ${quoteArg(src)} -C ${quoteArg(dest)})`;
  } else if (isTarBz2) {
    verboseCmd = `mkdir -p ${quoteArg(dest)} && (tar -xjvf ${quoteArg(src)} -C ${quoteArg(dest)} 2>/dev/null || tar -xvf ${quoteArg(src)} -C ${quoteArg(dest)})`;
  } else if (isTarXz) {
    verboseCmd = `mkdir -p ${quoteArg(dest)} && (tar -xJvf ${quoteArg(src)} -C ${quoteArg(dest)} 2>/dev/null || tar -xvf ${quoteArg(src)} -C ${quoteArg(dest)})`;
  } else {
    verboseCmd = `mkdir -p ${quoteArg(dest)} && tar -xvf ${quoteArg(src)} -C ${quoteArg(dest)}`;
  }

  const result = await execStreamingLines(client, verboseCmd, {
    timeoutMs: STREAM_OP_TIMEOUT_MS,
    onLine: (line) => {
      const file = cleanVerboseLine(line, isZip ? 'zip' : 'tar');
      if (!file) return;
      processedFiles += 1;
      emitRunning(file);
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || 'Extract failed').trim());
  }

  onProgress({
    phase: 'done',
    percent: 100,
    processedFiles,
    totalFiles: totalFiles || processedFiles,
  });
  return { archivePath: src, destinationDir: dest };
}

/** 同服务器复制或移动文件/目录。 */
async function copyOrMoveRemoteItems(client, { sources, destinationDir, mode = 'copy' }) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('sources are required');
  }
  const dest = requireValidPath(destinationDir, 'destinationDir');
  const cleanSources = sources.map((item) => requireValidPath(item, 'source'));
  const verb = mode === 'move' ? 'mv --' : 'cp -a --';
  const cmd = `${verb} ${cleanSources.map(quoteArg).join(' ')} ${quoteArg(dest)}`;
  const result = await execCommand(client, cmd, { timeoutMs: 120000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || `${mode} failed`).trim());
  }
  return { mode, count: cleanSources.length, destinationDir: dest };
}

/** 在远端创建符号链接：ln -s <targetPath> <linkPath>。 */
async function createRemoteSymlink(client, { targetPath, linkPath }) {
  const target = requireValidPath(targetPath, 'targetPath');
  const link = requireValidPath(linkPath, 'linkPath');
  const cmd = `ln -s -- ${quoteArg(target)} ${quoteArg(link)}`;
  const result = await execCommand(client, cmd, { timeoutMs: 15000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'ln -s failed').trim());
  }
  return { targetPath: target, linkPath: link };
}

/** 修改远端文件/目录属主属组（支持 owner 或 owner:group，格式严格校验）。 */
async function chownRemoteItem(client, { remotePath, owner, group, recursive = false }) {
  const target = requireValidPath(remotePath, 'remotePath');
  const safeOwner = String(owner ?? '').trim();
  const safeGroup = String(group ?? '').trim();
  const spec = safeGroup ? `${safeOwner}:${safeGroup}` : safeOwner;
  if (!spec || !/^[A-Za-z0-9_.-]*(?::[A-Za-z0-9_.-]+)?$/.test(spec)) {
    throw new Error('Invalid owner/group specification');
  }
  const flags = recursive ? '-R ' : '';
  const cmd = `chown ${flags}-- ${quoteArg(spec)} ${quoteArg(target)}`;
  const result = await execCommand(client, cmd, { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'chown failed').trim());
  }
  return { remotePath: target, spec, recursive: Boolean(recursive) };
}

module.exports = {
  archiveRemoteItems,
  extractRemoteArchive,
  copyOrMoveRemoteItems,
  createRemoteSymlink,
  chownRemoteItem,
};
