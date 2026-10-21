# MCP Server（给 AI Agent 使用）

`server/mcp/index.mjs` 是一个可选的 **stdio MCP 服务**，把 AI SSH Client 里
**已保存的 SSH 连接**暴露给 Claude Code、Cursor、DSH 等 MCP 客户端：
列目录、读文本文件、测试连接，以及在显式开启后执行非交互命令。

它不是远程 shell 代理，也不是沙箱。先读「[安全模型](#安全模型)」和「[已知限制](#已知限制)」再决定是否开启执行权限。

---

## 1. 它能做什么

| 工具 | 只读 | 说明 |
|---|---|---|
| `list_connections` | 是 | 列出已保存连接：id、名称、主机、端口、用户名、认证方式、指纹是否已信任。不含任何密码/私钥。 |
| `get_server_info` | 是 | 版本、数据目录、当前策略（执行是否开启、超时/输出上限）、审计日志位置。 |
| `test_connection` | 是 | 用保存的凭据连接并执行固定探测命令 `echo`，返回延迟和本次收到的主机指纹。 |
| `sftp_list` | 是 | 列远端目录（类型、大小、权限、mtime），最多 1000 项。 |
| `sftp_stat` | 是 | 查看单个路径的属性，不读内容。 |
| `sftp_read_text` | 是 | 读取远端 UTF-8 文本文件，默认上限 256 KB。 |
| `ssh_exec` | **否** | 在连接上执行一条非交互命令（SSH `exec` 通道，不分配 PTY），返回 stdout/stderr/exitCode。默认只读；可在 Web 设置 → MCP 里按连接开启，或设 `MCP_ALLOW_EXEC=1`。 |

MCP 只认**配置里已保存的连接**，不能由 agent 临时指定主机或凭据。这样既避免把凭据库变成任意转发代理，也让「agent 能连哪台机器」始终由人在界面里决定。

---

## 2. 前置条件

1. 连接保存在 **Web 网关的数据目录**（默认仓库下的 `data/config.json`），也就是 `npm run web` / Docker 部署使用的那份。
2. 凭据已加密时，启动 MCP 的进程要能拿到同一把密钥：
   - 网关用 `WEB_AUTH_PASSWORD` 派生密钥 → MCP 也要设同一个 `WEB_AUTH_PASSWORD`；
   - 网关用默认的 `data/secret.key` → MCP 指向同一 `AI_SSH_DATA_DIR` 即可。
3. 目标主机的主机指纹已信任（见 [指纹与首次连接](#指纹与首次连接)）。

> **桌面版（Tauri）目前用不了。** 桌面端密码/私钥存在系统钥匙串里，独立 Node 进程读不到。
> 本 MCP 只覆盖 Web/Docker 数据目录；桌面端支持需要在 Rust 侧另做 MCP 端点，尚未实现。

---

## 3. 启动与接入

### 3.1 在 Web 设置页配置（推荐）

打开 Web 网关（`npm run web` 或 Docker 部署），登录后进入 **设置 → MCP**：

- **默认执行模式**：`只读`（只允许列目录/读文件）或 `可执行命令`；
- **按连接配置**：给单台机器单独设 `只读` / `可执行`，未设置的跟随默认；
- **精确例外**：每行一条完整命令，只有整条命令完全相等才放行内置黑名单；
- **限额**：输出、超时、命令长度、读文件上限；
- **审计 / 首次连接自动信任** 开关。

保存后写入 **`<dataDir>/mcp-policy.json`**（默认 `data/mcp-policy.json`，已在 `.gitignore` 中），
**需要重启 MCP 进程**（例如重开 MCP 客户端）才会生效。页面同时会提示哪些环境变量正在覆盖文件。

等价的文件内容：

```json
{
  "defaultMode": "read-only",
  "trustOnFirstUse": false,
  "connections": {
    "1775546440824": "exec",
    "生产机": "read-only"
  },
  "commands": {
    "deny": ["\\bsome-dangerous-tool\\b"],
    "exceptions": ["systemctl restart nginx"]
  },
  "limits": {
    "maxOutputBytes": 262144,
    "execTimeoutMs": 30000,
    "maxCommandChars": 8192,
    "maxReadBytes": 262144
  },
  "audit": { "enabled": true }
}
```

字段规则：

- `connections` 的键可以是连接 **id** 或 **名称**（名称不区分大小写；同名时 id 优先）；
- `commands.deny` 只能**追加**正则，内置黑名单不能删除；
- `commands.exceptions` 只做**整条命令精确匹配**，不支持正则、前缀或通配；
- 未知字段、非法模式、非法正则、越界限额都会让 MCP **启动失败**并在 stderr 报错，避免「看起来保存成功、实际没生效」。

优先级：**连接级模式 > 显式设置的 `MCP_ALLOW_EXEC` > 文件 `defaultMode` > 默认只读**。
限额与审计同理：显式环境变量 > 文件 > 内置默认值。

### 3.2 手动启动与客户端配置

先安装依赖（仓库根目录）：

```bash
npm install
```

手动启动（会等待 stdin 上的 JSON-RPC，不会自己退出）：

```bash
npm run mcp
```

MCP 客户端配置示例（Windows 路径建议用 `/`，或把 `\` 写成 `\\`）：

```json
{
  "mcpServers": {
    "ai-ssh-client": {
      "command": "node",
      "args": ["D:/dev/ai-ssh-client/server/mcp/index.mjs"],
      "env": {
        "AI_SSH_DATA_DIR": "D:/dev/ai-ssh-client/data"
      }
    }
  }
}
```

常见配置文件位置：

- **Claude Code**：项目根的 `.mcp.json`，或用户级 `~/.claude.json`
- **Cursor**：项目 `.cursor/mcp.json`，或 `~/.cursor/mcp.json`
- **Claude Desktop**：`claude_desktop_config.json`（Windows 在 `%APPDATA%\Claude\` 下）

任何支持 stdio 传输的 MCP 客户端都可以用同样的 `command` / `args` / `env` 三元组接入。

> 执行权限建议在 Web 设置 → MCP 里按连接配置；如果所有连接都要开，也可以临时加 `"MCP_ALLOW_EXEC": "1"`。
> 配置里的 `env` 值必须写成字符串；JSON 数组类的变量需要转义，容易写错，建议优先用页面或默认值。

---

## 4. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AI_SSH_DATA_DIR` | 仓库下 `data/` | 配置与密钥所在目录；也接受 `DATA_DIR`。 |
| `WEB_AUTH_PASSWORD` | 无 | 与 Web 网关一致；设置后用它派生凭据解密密钥。 |
| `MCP_ALLOW_EXEC` | `0` | `1/true/yes/on` 时开放 `ssh_exec`；显式设置时覆盖策略文件的 `defaultMode`（连接级配置仍优先）。 |
| `MCP_POLICY_FILE` | `<dataDir>/mcp-policy.json` | 策略文件路径；相对路径按数据目录解析。 |
| `MCP_TRUST_ON_FIRST_USE` | `0` | `1` 时自动信任**首次**连接的主机；密钥变更仍然拒绝。 |
| `MCP_MAX_OUTPUT_BYTES` | `262144` | 单次命令 stdout+stderr 的合计上限（1 KB – 4 MB）。 |
| `MCP_EXEC_TIMEOUT_MS` | `30000` | 命令默认超时（1 s – 300 s）。 |
| `MCP_MAX_READ_BYTES` | `262144` | `sftp_read_text` 默认/上限（1 KB – 1 MB）。 |
| `MCP_MAX_COMMAND_CHARS` | `8192` | 单条命令最大长度。 |
| `MCP_DENY_PATTERNS` | 空 | JSON 字符串数组，**追加**到内置黑名单；内置规则不能关闭。 |
| `MCP_ALLOW_PATTERNS` | 空 | JSON 字符串数组；非空时每个命令片段都必须命中至少一条。 |
| `MCP_AUDIT_LOG` | `<dataDir>/mcp-audit.log` | 审计日志路径。 |
| `MCP_AUDIT` | 开启 | 设为 `0` 关闭审计。 |

非法数字或非法正则会**直接启动失败**（stderr 报错），而不是静默忽略。策略文件损坏同样会启动失败。

> `get_server_info` 会返回 `policyFile`（路径、是否存在）和 `envOverrides`（当前生效的覆盖变量），
> 可用来确认页面保存后到底有没有生效。

---

## 5. 安全模型

### 默认只读

默认 `defaultMode` 为 `read-only`：`ssh_exec` 返回 `exec-disabled`，只有列目录/读文件类工具可用。
在 Web 设置 → MCP 里把默认模式或某台机器改为「可执行」后，`ssh_exec` 才对该连接开放。

### 按连接与精确例外

- 每台机器可以单独设为 `read-only` / `exec`；生产机建议保持只读，只给测试机开执行；
- `commands.exceptions` 只放行**与整条命令完全一致**的字符串，且该连接必须处于 `exec` 模式；
- 例外优先于内置黑名单，因此它是「明知有风险、仍要在这台机器上执行」的显式决定，
  不要写 `.*`、`*` 或整段脚本；
- 把例外写成 `systemctl restart nginx` 不会放行 `systemctl restart nginx; rm -rf /`。

### 内置命令护栏

`ssh_exec` 在建立连接**之前**先过策略，命中即拒绝并写入审计：

- 递归删除 `/`、`~`、`$HOME`、`/etc`、`/usr`、`/boot`、`/var/lib` 等关键路径
  （含 `--no-preserve-root`、`/tmp/..` 这类归一化写法）
- 递归删除 `~/.ssh`、`/root/.ssh`、`~/.gnupg`、`~/.aws`、`/var/lib/mysql`、`/var/lib/docker` 等敏感子树
- `mkfs*`、`fdisk`、`parted`、`wipefs`、`mkswap`、`cryptsetup`
- `dd of=/dev/...`、直接写块设备
- `shutdown`、`reboot`、`halt`、`poweroff`、`kexec`、`init 0/6`
- `systemctl stop/restart sshd`、`service ssh stop`、关闭防火墙（`ufw disable`、`iptables -F`、`nft flush`）
- `kill 1` / `kill -9 -1`、`killall5`
- `chmod -R` / `chown -R` 作用于关键目录
- `find / -delete`
- `userdel root`、`passwd root`
- 覆盖 `/etc/passwd`、`/etc/shadow`、`/etc/sudoers`、`/boot`
- `curl|wget ... | sh`、`... | python`、fork 炸弹、`/dev/tcp` 反向 shell
- `bash -c "..."` / `eval "..."` 里嵌套的上述命令（递归检查，最多 3 层）

**这是护栏，不是沙箱。** 绕法很多：把命令写进脚本再执行、base64、shell 别名、远端已有程序、`eval` 等都能绕过。真正的隔离只能靠：

- 用权限受限的 SSH 账号（不要用 root），只给它需要的目录和命令；
- 主机侧限制（`sudoers` 白名单、只读挂载、容器/跳板机）；
- 只在确实需要时开执行权限（按连接开，而不是全局开），并定期看审计日志。

### 审计

每次 `ssh_exec`、`test_connection` 追加一行 JSON 到 `data/mcp-audit.log`（`data/` 已在 `.gitignore` 中）：

```json
{"ts":"2026-10-21T07:48:33.962Z","tool":"ssh_exec","connection":"1775546440824","host":"192.168.1.131","command":"rm -rf /","outcome":"blocked","code":"blocked","rule":"rm-critical-target"}
```

只记录命令与结果元数据，**不记录 stdout/stderr**（可能含密钥或 token）。命令文本截断到 2000 字符。
命令文本本身会被记录，因此不要把密钥、token 直接写在 `ssh_exec` 的命令行里。

### 凭据

- 只从配置读取，解密后仅存在于 MCP 进程内存；
- `list_connections` 只返回认证方式，不返回 `password` / `privateKey` / `passphrase`；
- 错误信息不拼接凭据。

### 指纹与首次连接

与桌面端/网关共用 `host_trust_records` 语义：

- 已信任且指纹、算法一致 → 直接连接；
- 未信任 → **拒绝**，错误里带上本次收到的指纹，提示先在 Web 界面里连接一次并确认；
- 已记录但指纹变化 → 拒绝（防中间人）；
- `MCP_TRUST_ON_FIRST_USE=1` 只自动信任**首次**连接，密钥变更仍拒绝。

自动信任时 MCP 会写 `config.json` 的 `hostTrustRecords` 字段；其他字段（含已加密凭据）原样保留。

---

## 6. 已知限制

- **桌面版不支持**：钥匙串凭据无法被独立 Node 进程读取，见上文。
- **没有写工具**：`sftp_write` / 上传 / 下载尚未提供。需要时建议先在界面里操作。
- **没有 HTTP 传输**：只有 stdio，一个 MCP 客户端对应一个进程；多个客户端各自拉起即可。
- **非交互**：`ssh_exec` 不分配 PTY。`sudo` 要密码、`vim`/`top` 这类全屏程序、需要 `y/n` 确认的命令会失败或超时；请用 `sudo -n`（已配置免密）或非交互参数。
- **与应用内终端互不影响**：MCP 用独立的 SSH 连接，不会干扰你在界面里打开着的会话。
- **并发**：同一进程内按 `connectionId` 复用一条连接；不同命令通过多个 `exec` 通道并发。

---

## 7. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `exec-disabled` | 该连接仍是只读。到 Web 设置 → MCP 把默认模式或这台机器改为「可执行」，保存后重启 MCP；或确认 `MCP_ALLOW_EXEC=1` 真的传给了 MCP 进程。用 `get_server_info` 看 `policyFile` / `envOverrides`。 |
| `未知连接` / `unknown-connection` | 连接只存在于桌面端，或 `AI_SSH_DATA_DIR` 指错了目录。先调 `list_connections`。 |
| 主机未信任 | 错误里会带 `SHA256:...` 指纹。到 Web 界面用同一 host/port 连一次并确认；或临时设 `MCP_TRUST_ON_FIRST_USE=1`。 |
| 主机密钥已变更 | 先确认是不是你换的密钥；不是就按中间人处理，不要直接清记录。 |
| 凭据解密失败 | 启动 MCP 的 `WEB_AUTH_PASSWORD` 与写配置时不一致，或 `secret.key` 不同。stderr 会有提示。 |
| `ssh-timeout` | 网络不通/端口错误，或目标主机指纹确认流程被跳过。先用 `test_connection` 定位。 |
| 客户端收不到响应 | 检查是否有代码往 **stdout** 打印日志；stdout 是 JSON-RPC 通道，日志只能走 stderr。 |

---

## 8. 实现位置

```text
server/mcp/
├── index.mjs      # stdio 入口、工具注册（唯一 ESM 文件，因为 MCP SDK 是 ESM-only）
├── services.cjs   # 工具层：策略检查、审计、结果组装
├── config.cjs     # 读取/解密 data/config.json，连接摘要与解析
├── policy.cjs     # 只读默认、按连接模式、命令黑名单/白名单、精确例外
├── policy-file.cjs # data/mcp-policy.json 的校验/读写（网关与 MCP 共用）
├── ssh.cjs        # ssh2 连接池、exec、SFTP、输出截断
├── audit.cjs      # JSONL 审计日志
└── errors.cjs     # 带错误码的工具错误
```

复用而非重写：

- 凭据解密 → `server/secret-store.cjs`
- 主机指纹 TOFU → `server/host-trust.cjs`
- 文本读取（路径校验、大小限制、二进制粗检）→ `server/sftp-items.cjs`

单元测试：`test/mcp-policy.test.ts`、`test/mcp-policy-file.test.ts`、`test/mcp-config.test.ts`、`test/mcp-ssh.test.ts`、`test/mcp-services.test.ts`；
`test/mcp-ssh-integration.test.ts` 会在本地起一个 ssh2 服务，真实跑通连接、指纹 TOFU 与 exec 通道，不依赖外部主机。

```bash
npx vitest run mcp
```

---

## 9. 后续可做

- SFTP 写入/上传/下载（需要单独的设计：是否允许覆盖、写到哪些目录、如何回滚）
- Streamable HTTP 传输（供容器内或远程 MCP 客户端接入）
- 桌面端 Rust MCP 端点（才能复用钥匙串凭据与应用内会话）
- 更细的授权（例如按连接限制可执行命令前缀、可访问目录范围）