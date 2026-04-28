# AI SSH Client

[English](README.md) | 简体中文

AI SSH Client 是一款桌面 SSH 客户端，集成了多会话终端、SFTP 文件传输和 AI 辅助 Linux 命令工作流。项目基于 Electron、React、TypeScript、xterm.js 和 Tailwind CSS 构建。

## 功能特性

- SSH 连接管理，支持密码认证和私钥认证。
- 多标签终端工作区，支持重连、Keepalive、标签切换和拖拽排序。
- 基于 xterm.js 的终端，支持搜索、字体调节、终端主题、命令补全和命令历史。
- AI 助手模式和智能体模式，可用于 Linux 命令咨询和任务执行。
- 多 AI 供应商配置，支持 OpenAI 兼容接口、Anthropic、Gemini 和 Ollama。
- 命令风险分析，高风险操作会进入审批流程。
- SFTP 文件浏览器，支持远程目录列表、上传、下载和传输进度。
- 快速命令和命令分组，便于保存常用 Shell 片段。
- 浅色、深色、跟随系统三种主题。
- 配置数据导入和导出。
- SSH 凭据和 AI API Key 本地安全存储。

## 安全说明

- 渲染进程只能通过 Electron preload 暴露的白名单 API 访问主进程能力，不提供通用 IPC invoke 入口。
- SSH 密码、私钥、私钥密码和 AI API Key 会从普通配置中拆分，独立存储。
- 系统支持时使用 Electron `safeStorage` 加密敏感数据；仅在平台不支持加密时回退到本地明文封装。
- 私钥文件只能通过原生文件选择器选中后读取。
- 智能体自动执行命令前仍会经过命令风险检查和执行日志记录。

## 技术栈

- 桌面运行时：Electron
- 前端框架：React + TypeScript
- 构建工具：Vite
- 终端：xterm.js
- SSH/SFTP：ssh2
- 状态管理：Zustand
- 样式：Tailwind CSS
- 本地存储：electron-store

## 快速开始

安装依赖：

```bash
npm install
```

启动开发模式：

```bash
npm run dev
```

构建应用：

```bash
npm run build
```

构建 Windows 安装包：

```bash
npm run dist:win
```

构建 Windows 便携版：

```bash
npm run dist:portable
```

也可以直接使用项目根目录下的 `启动开发模式.bat`、`启动开发模式.ps1` 和 `构建应用.bat`。

## 使用流程

1. 在连接菜单中新建 SSH 连接。
2. 填写主机、端口、用户名，并选择密码或私钥认证。
3. 点击连接，打开对应终端标签页。
4. 在 AI 面板中配置并激活 AI 供应商。
5. 在助手模式中咨询 Linux 命令，或在智能体模式中让 AI 通过受控命令步骤完成任务。
6. 连接成功后可使用传输按钮打开 SFTP 文件传输界面。

## 项目结构

```text
ai-ssh-client/
├── src/
│   ├── main/             # Electron 主进程
│   │   ├── ai/           # AI 供应商管理
│   │   ├── ipc/          # IPC 处理器
│   │   ├── security/     # 命令策略和风险检查
│   │   ├── ssh/          # SSH 和 SFTP 连接管理
│   │   ├── storage/      # 设置与密钥存储
│   │   ├── index.ts      # 主进程入口
│   │   └── preload.ts    # 暴露给渲染进程的 preload 桥
│   ├── renderer/         # React 渲染进程
│   │   ├── components/   # UI 组件
│   │   ├── hooks/        # 渲染进程 Hooks
│   │   ├── store/        # Zustand 状态
│   │   ├── App.tsx       # 主工作区界面
│   │   └── main.tsx      # 渲染进程入口
│   └── shared/           # 共享类型、常量和 IPC 契约
├── docs/                 # 项目说明和分析文档
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 和 Electron 开发模式。 |
| `npm run build` | 构建主进程和渲染进程。 |
| `npm run preview` | 预览渲染进程构建结果。 |
| `npm run pack` | 构建并生成未打包安装器的 Electron 应用目录。 |
| `npm run dist` | 构建发布产物。 |
| `npm run dist:win` | 构建 Windows 发布产物。 |
| `npm run dist:portable` | 构建 Windows 便携版。 |

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+F` | 搜索终端输出。 |
| `Ctrl++` | 放大终端字体。 |
| `Ctrl+-` | 缩小终端字体。 |
| `Esc` | 关闭终端搜索或命令补全面板。 |

## 数据与备份

连接元数据、设置、快速命令和 AI 供应商元数据通过 `electron-store` 保存在本机。SSH 和 AI 敏感密钥保存在独立的密钥存储中。需要迁移或备份时，可使用设置中的导入/导出功能处理可移植配置数据。

## 许可证

MIT
