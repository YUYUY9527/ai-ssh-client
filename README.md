# AI SSH Client

English | [简体中文](README.zh-CN.md)

AI SSH Client is a desktop SSH client that combines multi-session terminal access, SFTP file transfer, and AI-assisted Linux command workflows. It is built with React, Tauri, Rust, TypeScript, xterm.js, and Tailwind CSS.

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

- Renderer access is restricted to the Tauri command bridge exposed by the app.
- SSH passwords, private keys, passphrases, and AI API keys are stored separately from normal configuration data.
- Sensitive data is kept in the local Tauri/Rust storage layer and platform keyring where available.
- Private-key files can only be read after selection through the native file picker.
- Agent-driven command execution still passes through command risk checks and execution logging.

## Tech Stack

- Desktop runtime: Tauri
- Backend: Rust
- UI: React + TypeScript
- Build: Vite
- Terminal: xterm.js
- SSH/SFTP: Rust SSH/SFTP services
- State management: Zustand
- Styling: Tailwind CSS
- Storage: Tauri app data + platform keyring

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

Run the web app with Docker Compose:

```bash
docker compose up -d --build
```

Then open <http://localhost:5080>. Set `AI_SSH_CLIENT_WEB_PORT` to use another
host port. From another device on the same LAN, open
`http://<laptop-ip>:5080`.

Package a Windows build:

```bash
npm run dist:win
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
├── src-tauri/            # Tauri/Rust backend
│   └── src/
│       ├── commands/     # Tauri command handlers
│       ├── models/       # Rust data contracts
│       └── services/     # SSH, SFTP, AI, Agent, and storage services
├── src/
│   ├── renderer/         # React renderer
│   │   ├── components/   # UI components
│   │   ├── hooks/        # Renderer hooks
│   │   ├── store/        # Zustand stores
│   │   ├── App.tsx       # Main workspace UI
│   │   └── main.tsx      # Renderer entry
│   └── shared/           # Shared types and constants
├── docs/                 # Project notes and analysis docs
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Tauri development app. |
| `npm run build` | Build the Tauri application. |
| `npm run build:renderer` | Build the renderer bundle only. |
| `npm run preview` | Preview the renderer bundle. |
| `npm run dist` | Build distributable packages. |
| `npm run dist:win` | Build Windows distributables. |

## Docker Compose

The Compose deployment runs a Node web gateway and serves the React renderer in
the same container. Browser clients connect to the gateway, and the gateway
opens SSH/SFTP connections from the laptop running Docker. Connection data is
stored in the `ai-ssh-client-data` Docker volume.

Do not expose this service to an untrusted network. The web gateway can open SSH
connections using the credentials saved in the app. AI assistant and agent mode
remain desktop-only in the web deployment.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+F` | Search terminal output. |
| `Ctrl++` | Increase terminal font size. |
| `Ctrl+-` | Decrease terminal font size. |
| `Esc` | Close terminal search or autocomplete. |

## Data and Backups

Connection metadata, settings, quick commands, and AI provider metadata are stored locally through the Tauri/Rust storage service. Sensitive SSH and AI secrets are stored separately. Use the import/export tools in settings to back up or restore portable configuration data.

## License

MIT
