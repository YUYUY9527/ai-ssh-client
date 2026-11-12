'use strict';

/**
 * Agent 外部智能体（ACP）注册表。
 *
 * 配置存放在 DATA_DIR/agent-external-agents.json：
 *   { "enabled": false, "agents": [{ "name": "claude", "command": "claude-code-acp", "args": [] }] }
 *
 * 安全边界：enabled 默认 false；只有显式开启后才会允许启动外部智能体子进程。
 */

const fs = require('fs');
const path = require('path');

const MAX_AGENTS = 10;
const MAX_NAME_CHARS = 64;
const MAX_COMMAND_CHARS = 512;
const MAX_ARGS = 16;

function createAcpRegistry({ dataDir, fileName = 'agent-external-agents.json' } = {}) {
  if (!dataDir) throw new Error('createAcpRegistry requires dataDir');
  const filePath = path.join(dataDir, fileName);

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return normalize(JSON.parse(raw));
    } catch (error) {
      // 文件不存在或内容损坏时回退默认配置（enabled=false），
      // 避免一个坏文件让设置页/ACP 路由永久 500；损坏文件保留原样供排查。
      return { enabled: false, agents: [] };
    }
  }

  /** 清洗外部传入的配置；非法条目直接丢弃，不静默修正。 */
  function normalize(input) {
    const source = input && typeof input === 'object' ? input : {};
    const agents = Array.isArray(source.agents) ? source.agents : [];
    const clean = [];
    for (const agent of agents.slice(0, MAX_AGENTS)) {
      if (!agent || typeof agent !== 'object') continue;
      const name = typeof agent.name === 'string' ? agent.name.trim().slice(0, MAX_NAME_CHARS) : '';
      const command = typeof agent.command === 'string' ? agent.command.trim().slice(0, MAX_COMMAND_CHARS) : '';
      if (!name || !command) continue;
      const args = Array.isArray(agent.args)
        ? agent.args.filter((arg) => typeof arg === 'string' && arg.length <= MAX_COMMAND_CHARS).slice(0, MAX_ARGS)
        : [];
      clean.push({ name, command, args });
    }
    return { enabled: source.enabled === true, agents: clean };
  }

  function save(config) {
    const clean = normalize(config);
    ensureDir();
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
    return clean;
  }

  function get(name) {
    const config = load();
    return config.agents.find((agent) => agent.name === name) || null;
  }

  return { load, save, get, filePath };
}

module.exports = { createAcpRegistry };
