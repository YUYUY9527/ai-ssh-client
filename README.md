# AI SSH Client

English | [简体中文](README.zh-CN.md)

AI SSH Client is a desktop SSH client that combines multi-session terminal access, SFTP file transfer, and AI-assisted Linux command workflows. It is built with Electron, React, TypeScript, xterm.js, and Tailwind CSS.

## Features

- SSH connection management with password and private-key authentication.
- Multi-tab terminal workspace with reconnect, keepalive, tab switching, and tab reordering.
- xterm.js terminal with search, font-size controls, theme selection, command autocomplete, and command history.
- AI assistant and agent modes for Linux command help and task execution.
- Multiple AI providers, including OpenAI-compatible endpoints, Anthropic, Gemini, and Ollama.
- Command risk analysis and approval gates for dangerous operations.
- SFTP browser for listing remote directories, uploading files, downloading files, and tracking transfer progress.
- Quick commands and command groups for frequently used shell snippets.
- Light, dark, and system themes.
- Import and export for app configuration data.
- Local secret storage for SSH credentials and AI API keys.

## Security Notes

- Renderer access is restricted through Electron preload APIs. The renderer does not receive a generic IPC invoke escape hatch.
- SSH passwords, private keys, passphrases, and AI API keys are stored separately from normal configuration data.
- The app uses Electron `safeStorage` when encryption is available, with a local plaintext fallback only when the platform cannot provide encryption.
- Private-key files can only be read after selection through the native file picker.
- Agent-driven command execution still passes through command risk checks and execution logging.

## Tech Stack

- Desktop runtime: Electron
- UI: React + TypeScript
- Build: Vite
- Terminal: xterm.js
- SSH/SFTP: ssh2
- State management: Zustand
- Styling: Tailwind CSS
- Storage: electron-store

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development app:

```bash
npm run dev
```

Build the app:

```bash
npm run build
```

Package a Windows build:

```bash
npm run dist:win
```

Create a portable Windows build:

```bash
npm run dist:portable
```

## Usage

1. Create an SSH connection from the connection menu.
2. Enter host, port, username, and either password or private-key credentials.
3. Connect to open a terminal tab.
4. Configure an AI provider from the AI panel settings.
5. Ask the assistant for Linux command help, or use agent mode to execute a task through guarded command steps.
6. Use the transfer button when connected to browse remote files through SFTP.

## Project Structure

```text
ai-ssh-client/
├── src/
│   ├── main/             # Electron main process
│   │   ├── ai/           # AI provider management
│   │   ├── ipc/          # IPC handlers
│   │   ├── security/     # Command policy and guard logic
│   │   ├── ssh/          # SSH and SFTP connection management
│   │   ├── storage/      # Settings and secret storage
│   │   ├── index.ts      # Main process entry
│   │   └── preload.ts    # Preload bridge exposed to renderer
│   ├── renderer/         # React renderer process
│   │   ├── components/   # UI components
│   │   ├── hooks/        # Renderer hooks
│   │   ├── store/        # Zustand stores
│   │   ├── App.tsx       # Main workspace UI
│   │   └── main.tsx      # Renderer entry
│   └── shared/           # Shared types, constants, and IPC contracts
├── docs/                 # Project notes and analysis docs
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite and Electron in development mode. |
| `npm run build` | Build main and renderer bundles. |
| `npm run preview` | Preview the renderer bundle. |
| `npm run pack` | Build and package an unpacked Electron app. |
| `npm run dist` | Build distributable packages. |
| `npm run dist:win` | Build Windows distributables. |
| `npm run dist:portable` | Build a Windows portable executable. |

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+F` | Search terminal output. |
| `Ctrl++` | Increase terminal font size. |
| `Ctrl+-` | Decrease terminal font size. |
| `Esc` | Close terminal search or autocomplete. |

## Data and Backups

Connection metadata, settings, quick commands, and AI provider metadata are stored locally through `electron-store`. Sensitive SSH and AI secrets are stored in separate secret stores. Use the import/export tools in settings to back up or restore portable configuration data.

## License

MIT
