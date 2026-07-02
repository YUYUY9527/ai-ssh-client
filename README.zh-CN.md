# AI SSH Client

[English](README.md) | 简体中文

AI SSH Client 是一款桌面 SSH 客户端，集成了多会话终端、SFTP 文件传输和 AI 辅助 Linux 命令工作流。项目基于 React、Tauri、Rust、TypeScript、xterm.js 和 Tailwind CSS 构建。

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

- 渲染进程只能通过应用暴露的 Tauri command bridge 访问后端能力。
- SSH 密码、私钥、私钥密码和 AI API Key 会从普通配置中拆分，独立存储。
- 敏感数据由本地 Tauri/Rust 存储层处理，并在可用时使用平台 keyring。
- 私钥文件只能通过原生文件选择器选中后读取。
- 智能体自动执行命令前仍会经过命令风险检查和执行日志记录。

## 技术栈

- 桌面运行时：Tauri
- 后端：Rust
- 前端框架：React + TypeScript
- 构建工具：Vite
- 终端：xterm.js
- SSH/SFTP：Rust SSH/SFTP 服务
- 状态管理：Zustand
- 样式：Tailwind CSS
- 本地存储：Tauri 应用数据 + 平台 keyring

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

使用 Docker Compose 运行 Web 版：

```bash
docker compose up -d --build
```

然后访问 <http://localhost:5080>。如需修改宿主机端口，可设置
`AI_SSH_CLIENT_WEB_PORT`。局域网内其他设备访问
`http://<笔记本IP>:5080`。

构建 Windows 安装包：

```bash
npm run dist:win
```

也可以直接使用项目根目录下的 `build.bat`。

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
├── src-tauri/            # Tauri/Rust 后端
│   └── src/
│       ├── commands/     # Tauri 命令处理
│       ├── models/       # Rust 数据契约
│       └── services/     # SSH、SFTP、AI、Agent 和存储服务
├── src/
│   ├── renderer/         # React 渲染进程
│   │   ├── components/   # UI 组件
│   │   ├── hooks/        # 渲染进程 Hooks
│   │   ├── store/        # Zustand 状态
│   │   ├── App.tsx       # 主工作区界面
│   │   └── main.tsx      # 渲染进程入口
│   └── shared/           # 共享类型和常量
├── docs/                 # 项目说明和分析文档
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Tauri 开发应用。 |
| `npm run build` | 构建 Tauri 应用。 |
| `npm run build:renderer` | 仅构建渲染进程资源。 |
| `npm run preview` | 预览渲染进程构建结果。 |
| `npm run dist` | 构建发布产物。 |
| `npm run dist:win` | 构建 Windows 发布产物。 |

## Docker Compose

Compose 部署会在同一个容器中运行 Node Web 网关并提供 React 页面。
浏览器连接这个网关，由运行 Docker 的笔记本发起 SSH/SFTP 连接。连接数据
保存在 `ai-ssh-client-data` Docker volume 中。

不要将该服务暴露到不可信网络。Web 网关可以使用应用中保存的凭据发起 SSH
连接。AI 助手和智能体模式在 Web 部署中仍仅桌面端可用。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+F` | 搜索终端输出。 |
| `Ctrl++` | 放大终端字体。 |
| `Ctrl+-` | 缩小终端字体。 |
| `Esc` | 关闭终端搜索或命令补全面板。 |

## 数据与备份

连接元数据、设置、快速命令和 AI 供应商元数据通过 Tauri/Rust 存储服务保存在本机。SSH 和 AI 敏感密钥保存在独立的密钥存储中。需要迁移或备份时，可使用设置中的导入/导出功能处理可移植配置数据。

## 许可证

MIT
