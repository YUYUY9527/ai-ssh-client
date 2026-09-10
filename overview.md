# AI SSH Client — 架构说明与变更记录

> 本文档描述**当前**代码库（Tauri 2 + Rust，双运行时）的架构、关键子系统与变更历史。
> 最后更新：2026-09-10。
>
> ⚠️ 本文档曾长期停留在 Electron 时代（`src/main/ipc/*`、`preload.ts`、`connection-manager.ts` 等文件自 2026-05-22 的 Rust 重构后已不存在）。旧版内容可从 git 历史找回：`git log --follow -- overview.md`。

---

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 定位 | 桌面 SSH 客户端 + 可选 Web 网关，统一多会话终端、SFTP 传输与 AI 辅助 Linux 命令工作流 |
| 桌面运行时 | Tauri 2（系统 WebView，非 Chromium 打包） |
| 后端 | Rust：`russh` / `russh-sftp` |
| Web 后端 | Node.js：`express` + `ws` + `ssh2` |
| 前端 | React 18 + TypeScript + Vite + Zustand + Tailwind CSS |
| 终端 | xterm.js（`@xterm/xterm` + fit / search / web-links 插件） |
| Agent 编排 | 自研顺序流水线（`agent-flow.ts`，2026-09-10 移除 LangGraph） |
| 存储 | 元数据 `store.json`；Agent 历史 SQLite（`rusqlite`）；敏感凭据走系统钥匙串（`keyring`） |
| 测试 | Vitest（23 个文件 / 148 个用例）+ `cargo test` |

代码规模（约）：

| 区域 | 行数 |
|---|---|
| `src/`（渲染进程） | 22,600 |
| `src-tauri/src/`（Rust 后端） | 6,650 |
| `server/`（Web 网关） | 3,200 |
| `test/` | 2,370 |

---

## 2. 双运行时架构（核心设计）

同一套 React 渲染层跑在两种后端之上，启动时按环境注入不同的 API 实现：

```ts
// src/renderer/main.tsx
if (!window.electronAPI && '__TAURI_INTERNALS__' in window) {
  installNativeApi();   // lib/native.ts → Tauri invoke / event
} else if (!window.electronAPI) {
  installWebApi();      // lib/web.ts   → fetch / WebSocket
}
```

`lib/native.ts`（16 KB）与 `lib/web.ts`（42 KB）导出**完全相同的函数签名**，业务代码只调用 `window.electronAPI.*`，不感知运行时。

| 能力 | 桌面端 | Web 端 |
|---|---|---|
| 传输通道 | `invoke()` + Tauri event | HTTP REST + WebSocket |
| 后端实现 | Rust `commands/*.rs`（68 个 `#[tauri::command]`） | `server/index.cjs`（66 条路由 + WS） |
| SSH 协议栈 | `russh` / `russh-sftp` | `ssh2` |
| 密钥存储 | 系统钥匙串（Windows Credential Manager 等） | `data/config.json` + 密码哈希会话 Cookie |
| 文件选择 | 原生对话框（`tauri-plugin-dialog`） | `<input type="file">` / File System Access API |
| AI 调用 | Rust `ai_service.rs` 直连 | `server/index.cjs` 代理转发 |

**约束**：新增后端能力必须**两侧同时实现**，否则该功能在另一运行时静默失效（`app.post('/api/unsupported')` 是 Web 端显式兜底）。

---

## 3. 模块地图

### 3.1 渲染进程 `src/renderer/`

```text
app/          应用壳层：AppController、AppShell、ModalHost、ToastHost、
              WorkspaceHeader、AppFooter、VersionUpdateBanner
session/      会话模型、bridge、recovery、store
  terminal/   终端子系统（全项目最重的部分，17 个模块）
transfer/     SFTP 浏览器、侧边栏、在线编辑器、任务列表、冲突对话框、
              reducer、controller
workspace/    标签页、布局、workspace store
assistant/    AI 侧车、风险审批服务、命令策略
agent/        agent-runtime.ts（62 KB）、agent-flow.ts（顺序流水线）、
              agent-token-estimate.ts（无依赖纯函数）
ai/           命令风险分析、命令抽取
history/      命令历史索引、面板、store
connection/   导入导出弹窗、备份加密、OpenSSH config 解析
store/        Zustand stores（agent / ai / connection / sftpTransfer）
i18n/         en-US、zh-CN
lib/          native.ts、web.ts、native/*、version-check
shared-ui/    Modal、ConfirmDialog、IndustrialSelect
components/   早期扁平组件（FileTransfer、AgentPet、AgentThinking、
              ConnectionList、SettingsPanel、QuickCommandsPanel 等）
```

`session/terminal/` 子模块职责：

| 模块 | 职责 |
|---|---|
| `useXtermInstance.ts` | xterm 实例生命周期 |
| `terminal-alt.ts` | alt-screen（1049 / 1047 / 47）翻转状态机 |
| `terminal-output-sync.ts` | 远端输出与本地缓冲同步、转义序列边界对齐 |
| `terminal-replay.ts` | 重连后的画面重放 |
| `terminal-cwd.ts` / `shell-cwd-probe.cjs` | 提示符跟踪与当前工作目录探测 |
| `shell-integration.ts` | Shell 集成脚本注入 |
| `paste-safety.ts` | 多行粘贴确认 |
| `terminal-settings.ts` / `terminal-theme.ts` | 终端配置与主题 |

### 3.2 Rust 后端 `src-tauri/src/`

```text
lib.rs                应用状态装配 + 68 个命令注册
commands/             ssh、connections、ai、agent、settings、files
models/               ssh、sftp、ai、settings、ipc 数据契约
services/
  ssh_service.rs      连接池、会话、keepalive、主机指纹校验
  sftp_service.rs     目录、编辑、权限、传输（67 KB，最大模块）
  storage_service.rs  store.json + 钥匙串读写
  ai_service.rs       Provider 调用与流式响应
  agent_service.rs    Agent 任务执行
  agent_history_service.rs  Agent 历史（rusqlite）
  sentinel.rs         Agent 输出哨兵剥离
error.rs
```

### 3.3 Web 网关 `server/`

```text
index.cjs             主服务：66 条路由 + WebSocket（60 KB）
auth.cjs              密码哈希、会话 Cookie、改密
sftp-transfer.cjs     传输任务、断点续传
sftp-items.cjs        目录列举、重命名、删除
sftp-upload.cjs       上传
shell-cwd-probe.cjs   工作目录探测
sentinel.cjs          Agent 哨兵剥离
```

---

## 4. 关键子系统

### 4.1 终端渲染管线

项目投入最大的子系统。核心难点是**远端 PTY 的字节流是不可分割的转义序列序列，而传输层按窗口切分**，直接截断会产生乱码、行号粘连、重放死循环等问题。现有对策：

- `alignToEscapeBoundary()` + `escapeSequenceEndAt()`：切分点对齐到完整转义序列边界，识别 CSI 终结字节、字符串序列尾部（`]` `P` `X` `^` `_`）、双字节前缀（`(` `)` `*` …）。
- 输出缓冲上限 1 MB，超出按滑动窗口丢弃。
- alt-screen 翻转（进入/退出 vim、nano、top）单独建状态机，避免注入头参与滑动对齐。
- PTY 尺寸握手：`resize` 走 **WebSocket 有序通道**，避免与数据通道乱序导致 vim 按错误行列绘制。

### 4.2 Agent 运行时

- `agent-runtime.ts` 承载主循环；`agent-flow.ts` 编排单轮决策（模型调用 → 响应解析 → 动作路由 → 可选执行）与命令执行流程，通过动态 `import()` 做代码分割。**2026-09-10 前该模块用 LangGraph `StateGraph`**，经评估确认两个图均为严格线性流水线（零条件边 / 中断 / 检查点）后改为自研顺序流水线，详见 [`docs/langgraph-removal-assessment.md`](docs/langgraph-removal-assessment.md)。
- 命令风险分级（`analyze-command-risk.ts`）+ 审批门（`RiskApprovalService` / `command-policy.ts`），支持「记住本次选择」按风险等级会话级生效。
- 执行结果写入命令历史（`executedBy: 'ai'`）与 Agent 任务历史（SQLite）。
- 哨兵输出剥离在桌面（`sentinel.rs`）与 Web（`sentinel.cjs`）两侧行为对齐。

### 4.3 SFTP 任务体系

- 统一任务契约：`waiting-conflict` / `canceled` / `failed` / `interrupted` 等状态，可取消、可重试、终态可移除。
- 检查点续传：`size + mtime` 指纹 + 头尾 SHA-256，`.part` + `.meta` 边车文件；取消保留分片，丢弃时清理。
- 原子提交：先写临时文件，成功后 rename。
- 冲突策略：overwrite / skip / rename，可选「应用到本批次剩余」。
- 生产力能力：多选（点击 / Ctrl / Shift / 全选）、批量删除与下载、新建目录、右键菜单、在线编辑、复制路径、改权限、真实拖放上传。

### 4.4 AI Provider

**全部四种 Provider 都走 OpenAI-compatible chat-completions 协议**，差异仅在预设 base URL 与默认模型（`ai_service.rs` / `server/index.cjs`）：

| 类型 | 预设 base URL | 默认模型 |
|---|---|---|
| `openai-compatible` | 用户填写 | 用户填写 |
| `anthropic` | `https://api.anthropic.com/v1` | `claude-3-5-sonnet-latest` |
| `gemini` | `.../v1beta/openai` | `gemini-2.0-flash` |
| `ollama` | `http://127.0.0.1:11434/v1` | `llama3.1` |

> 不存在原生 Anthropic Messages / Gemini 协议适配层，UI 中相应选项标注为 `(compatible)`。接入原生协议是明确的后续项。

### 4.5 存储与密钥

- **元数据**（连接、设置、快捷命令、Provider 配置、命令历史）→ `store.json`。
- **Agent 任务历史** → SQLite（`rusqlite`，仅 `agent_history_service.rs` 使用）。
- **敏感数据**（SSH 密码、私钥、passphrase、AI API Key）→ 系统钥匙串，`KEYRING_SERVICE = "ai-ssh-client"`，**不落 store.json**。
- 桌面端元数据位置：`%LOCALAPPDATA%\ai-ssh-client\store.json`。

### 4.6 Web 网关鉴权

- 首次启动初始密码 `admin`，仅存**加盐哈希**，UI 内可改密（改密后保留当前会话、踢掉其他会话）。
- 亦可用 `AI_SSH_CLIENT_WEB_PASSWORD` 环境变量钉住密码（此模式不落盘、UI 不可改）。
- 默认绑定 `127.0.0.1`；`WEB_HOST=0.0.0.0` 或 Docker 对外暴露。
- Cookie 在 HTTPS（含 `X-Forwarded-Proto`）下自动置 `Secure`。
- **密码明文过 HTTP**，任何不可信网络必须前置 TLS 反代。

---

## 5. 构建、测试与发布

| 命令 | 说明 |
|---|---|
| `npm run dev` | Tauri 开发应用 |
| `npm run build` / `dist:win` | 构建桌面安装包（输出 `src-tauri/target/release/bundle/nsis/`） |
| `npm run build:renderer` | 仅构建渲染层（输出 `dist/renderer/`） |
| `npm run typecheck` | 渲染层类型检查 |
| `npm test` / `test:watch` / `test:coverage` | Vitest |
| `npm run test:rust` | `cargo test` |
| `npm run check` | typecheck + test + build:renderer |
| `npm run web` | 启动 Web 网关（`node server/index.cjs`） |

分组测试脚本：`test:sentinel`、`test:history`、`test:sftp`、`test:ui`、`test:terminal`。

CI（`.github/workflows/ci.yml`）：frontend（ubuntu：typecheck + test + build）与 backend（windows：cargo test）两条腿。
Release（`.github/workflows/release.yml`）：推送 `v*` tag 触发 `tauri-action`，构建 Windows NSIS 安装包并发布**草稿** Release。

**Web 部署**：推荐 `docker compose up -d --build`（<http://localhost:5080>，数据存 `ai-ssh-client-data` 卷），Compose 已处理容器网络与持久化卷。

---

## 6. 变更记录

> 共 97 次提交（2026-04-17 → 2026-09-04）。

### 阶段一：Electron 原型（2026-04）

`c057e87` 首次提交 → 终端与传输 UI、Agent 长命令响应性、渲染进程权限收敛、中英双语文档。
此阶段的架构笔记（`src/main/ipc/`、`preload.ts` 等）已被下文的 Rust 重构取代。

### 阶段二：桌面端功能迭代（2026-05 ~ 2026-06）

- `19751e5` / `af63227` UI 页面两轮重构；`4a65dee` 动画版 AI 机器人（`AgentPet`）。
- `f15033e` 语言切换；`e17e938` 移除自动补全（改由终端 Tab 触发）。
- 终端输出与命令异常修复（`faadf02`、`5d001c2`、`20f7e3a`），多连接问题（`90eb11d`）。
- `7166979` SFTP 优化；`6841ae6` 快捷键复制粘贴；`6f63a29` 补充代码注释。

### 阶段三：Electron → Tauri / Rust 重构（2026-05-22 起）

- `b8e1e0b` **rust重构后端** —— 架构转折点：`ssh2`(Node) → `russh`(Rust)，IPC 从 Electron preload 改为 Tauri `invoke` + event，密钥改存系统钥匙串。
- `8aa80d9` 大规模重构，确立 `renderer/` 按领域分目录的结构。

### 阶段四：Web 部署（2026-07-02）

- `b22c370` Docker 部署 + Web 访问；`3825b9f` 端口调整。
- `9951cff` Web 端连接导入导出；`5d50ea6` Web 端适配 AI 与智能体能力。
- `4f092f9`~`5ccd38f` 连续 8 次修复 Web 端粘贴问题；`b885e39` 刷新页面自动重连。

### 阶段五：工程化与体验打磨（2026-07-07 ~ 2026-07-16）

- `9d099a4` 桌面/Web 两侧 Agent sentinel 输出剥离对齐。
- `633938b`~`30a01ab` SSH/SFTP 工作台、私钥配置入口、AI 侧车降噪、弹窗基座统一、会话恢复。
- `409a969`~`4c0b4b0` AI 语义摘要与终端上下文感知、智能体流式输出、SFTP 绑定会话、命令历史分层、主机指纹 TOFU 确认弹窗。
- `59eec0c`~`591bf3a` SFTP 右键操作、统一任务体系、半成品缺陷修复（临时会话重连、SFTP 缓存复用、Agent 审批与历史）。
- `3645410` 连接窗口配置导入导出（合并/覆盖 + 冲突预览 + 加密备份包 + OpenSSH config 导入）。
- `804b60e` 现代前端 UI：统一设计 token 与壳层样式。
- `bed05ba` SFTP 在线编辑、路径补全、复制路径、改权限。
- `879b5d3` 终端专业设置：scrollback、光标、选中复制、多行粘贴确认、会话日志、Shell Integration。
- `71e4a15` Web 网关加访问令牌鉴权 + **测试迁移到 Vitest**；`6c37152` 鉴权改为密码。
- `a90ade9` 新增 Release 工作流（`v*` tag 自动构建并发布草稿）。

### 阶段六：终端渲染加固（2026-07-27 ~ 2026-09-04）

集中治理 Web 端终端渲染的疑难问题，是近期主要工作：

| 提交 | 问题 |
|---|---|
| `01a8496` | Web 终端输出乱码 |
| `f83ae34` | Web 大文件上传超时 |
| `04e98ab` | 终端无限刷屏 |
| `5202ae0` / `c0ad9c5` / `861187f` | 右键传输目录未跳转；获取真实路径；Web 端无法输入 |
| `0da73b3` | 多客户端共享同一 SSH 会话导致串命令 |
| `677918e` | 连接成功后偶发无法输入 |
| `ccf3431` | vim 打开大文件显示不全、向下滚动丢内容 |
| `ff2ea83` | 部署更新后浏览器缓存自动处理 + Web 会话假死 |
| `9d7ceca` | 连接成功后反复重连失败（重连风暴）回归 |
| `e76accf` | 长时间放置后断连卡在重连中；重连后终端只渲染左上角小块 |
| `1b5eff6` | Web 端 nano 编辑超长文本显示不全、底部指引消失 |
| `3f1b653` | 1049h 注入头参与滑动对齐导致重放死循环（nano 行号重叠） |
| `a1c2420` | 转义序列被截断切碎、注入头打断悬挂续接导致行号粘连 |
| `9c6db36` | vim 渲染错乱；关闭标签后幽灵会话占用文件 |
| `e43dee3` | resize 改走 WS 有序通道，修复 vim 启动底部缺行 |
| `24c861b` | PTY 尺寸握手期丢失导致 top/vim 按错误行列绘制 |
| `8d8c94a` | 条件调用 `useSessionStore` 导致连接后黑屏 |

### 阶段七：工程清理（2026-09-10）

- 移除 Trellis 项目管理脚手架：`.trellis/`（spec / tasks / workspace）、`.agents/skills/`（12 个技能）、`.codex/`、`.claude/`、`AGENTS.md`、`.clawd-todos.json`。
- 删除 `release/` 下 462.8 MB **Electron 时代旧产物**（`win-unpacked/`、`app.asar`、electron-builder 配置）。当前 Tauri 安装包输出在 `src-tauri/target/release/bundle/nsis/`，体积约 4.95 MB。
- **修复 LangGraph 误打包**：纯函数 `estimateAgentMessagesTokens` 原本住在 `langgraph-agent-flow.ts`（该文件静态导入 `@langchain/langgraph`），被 `agent-runtime.ts` **静态导入**后把 827.7 KB 依赖树拽进了 `AgentExecutor` chunk，令代码中两处刻意的 `await import()` 懒加载失效。抽至无依赖的 `agent-token-estimate.ts` 后，`AgentExecutor` 从 **841.7 KB 降至 32.9 KB**，LangGraph 回归 827.7 KB 独立懒加载 chunk。收益为**缓存粒度**（稳定依赖 hash 与业务代码解耦），非总体积 —— 任务运行时两个 chunk 仍都会加载。
- **发现并修复中止语义缺陷**：Agent 执行命令期间点「暂停」会被判为任务失败 —— `runAgentExecutionGraph` 的 `executeCommand` 用裸 `catch` 吞掉了 `AbortedByRuntimeError`，而上层依赖该类型区分「被中止」与「执行失败」。已修复为向上重抛，并新增 3 个回归用例（回退修复即失败，已验证）。
- **拆除 LangGraph**：经评估确认 `langgraph-agent-flow.ts` 的两个图均为严格线性流水线（零条件边 / 环 / 中断 / 检查点 / 并行扇出），改写为 11 KB 的顺序流水线 `agent-flow.ts`，`@langchain/langgraph` 与 `@langchain/core` 从依赖树移除。**前端 JS 从 1668.7 kB 降至 843.7 kB（-49.4%）**，最大 chunk 从 827.7 kB 降至 303.6 kB（xterm），Vite 的「chunk > 500 kB」告警消失。31 个契约测试在重写后**一行未改**即全部通过。
- **补声明 `jsdom`**：4 个测试文件依赖 `@vitest-environment jsdom`，但该包从未写入 `package.json`（仅存在于本地 `node_modules`）—— 干净安装即会让这些测试加载失败。已补入 `devDependencies`。
- 本文档重写为 Tauri 架构版本。
- **补上 Agent 主路径测试**：新增 `test/agent-flow.test.ts`，锁定 `runAgentRoundGraph` / `runAgentExecutionGraph` 的公开契约 —— 覆盖全部决策出口与中止语义，为 LangGraph 拆除提供安全网。测试有效性经变异测试验证（9 处定向破坏捕获 8 处）。全套测试从 117 项增至 **148 项**。

---

## 7. 已知技术债

1. **巨石文件**：`components/FileTransfer.tsx`（69 KB / 1840+ 行）、`server/index.cjs`（60 KB / 66 路由）、`agent-runtime.ts`（62 KB）、`AgentPet.tsx`（41 KB）、`index.css`（62 KB）。
2. **转出兼容垫片**：`components/Terminal.tsx`、`components/SettingsPanel.tsx`、`settings/SettingsPanel.tsx`、`shared-ui/ConfirmDialog.tsx`、`transfer/useTransferStore.ts`、`assistant/AssistantStore.ts` 等仅 0.1 KB 的 re-export，属于重构残留。
3. **`components/` 与新领域目录并存**：`FileTransfer.tsx` 与 `transfer/` 重叠，未完成收敛。
4. **双运行时同步成本**：每项后端能力需实现两遍，且缺乏契约一致性测试（`src/shared/ipc-types.ts` 是事实契约但无自动校验）。
5. **README 结构图与事实不符**：`docs/ # Architecture notes` 实际只有两张截图加一份评估文档；未反映 `server/`、`test/` 双运行时结构。
6. **`.gitignore` 存在死规则**：`.agents`、`.codex`、`.trellis`、`AGENTS.md`、`.clawd-todos.json` 已随清理失效。
7. **原生 AI 协议缺失**：Anthropic / Gemini 仅经 OpenAI-compatible 端点接入。
8. **Web 端功能受限**：AI 助手与 Agent 能力在 Web 部署下部分不可用（见 `/api/unsupported`）。
> **2026-09-10 已清除的技术债**（经过记录于阶段七，评估依据见 [`docs/langgraph-removal-assessment.md`](docs/langgraph-removal-assessment.md)）：
>
> - **LangGraph 用于两条直线流水线** —— 已拆除，`@langchain/langgraph` / `@langchain/core` 从依赖树移除。
> - **Agent 主路径零测试覆盖** —— 已由 `test/agent-flow.test.ts` 补上（31 用例，经变异测试验证有效）。
> - **`runAgentExecutionGraph` 每次调用重新编译图** —— 已随拆除消失（不再有编译步骤）。
> - **中止语义不一致（暂停被误判为任务失败）** —— 已修复并加回归防线。
> - **`jsdom` 未在 `package.json` 中声明** —— 4 个测试文件依赖 `@vitest-environment jsdom`，但该包只存在于本地 `node_modules`，任何干净安装（`npm ci` / 新克隆 / CI）都会使其加载失败。已补入 `devDependencies`。
