# AI SSH Client

**English** | [简体中文](README.zh-CN.md)

A self-hosted, browser-based SSH workspace: a full terminal, SFTP file manager, server monitoring, Docker management and an optional AI assistant — all served from a single Node.js process. No desktop install; open a URL and work.

<p align="center">
  <img src="docs/首页.png" alt="AI SSH Client — terminal workspace" width="900" />
</p>

<p align="center">
  <img src="docs/容器管理.png" alt="AI SSH Client — Docker container management" width="900" />
</p>

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Getting Started](#getting-started)
- [Docker / Web Deployment](#docker--web-deployment)
- [Security](#security)
- [MCP for AI Agents](#mcp-for-ai-agents)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Development](#development)
- [Data and Backups](#data-and-backups)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Multi-session SSH** — password, private-key, Key Vault (`Ed25519`/`RSA` generator & `ssh-copy-id`), `keyboard-interactive` 2FA prompts, multi-hop jump hosts (with saved-connection references), HTTP / SOCKS5 proxies, SSH Agent Forwarding, custom terminal encoding (`UTF-8`/`GBK`/`Shift_JIS`, etc.), startup commands, reconnect and keepalive.
- **Nested connection groups** — organize servers into multi-level folder hierarchies.
- **Split terminal workspace** — drag tabs to split left/right/up/down, up to four panes side by side, each labelled with its server.
- **Rich terminal** — xterm.js with search, themes, configurable font and scrollback, command history, autocomplete, bracketed paste, full-screen-program-safe input mode, session recording & asciinema v2 `.cast` playback, and a mobile touch virtual key bar (PWA-ready).
- **Session-bound SFTP** — browse, upload, download (including non-HTTPS LAN Blob fallback), remote archive/extract (`.tar.gz`/`.zip`), server-side copy/move, symlinks, `chown`, bookmarks, multi-language CodeMirror syntax highlighting, recursive folder transfer, remote file preview (images, PDF, audio/video streaming) and remote file search.
- **Transfer queue** — per-task and bulk pause / resume with real resumable transfers, plus preserved source mtime on upload.
- **Port forwarding** — local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`) forwards managed from the terminal toolbar.
- **Server monitoring** — cross-platform (Linux / macOS / FreeBSD) live CPU per core, memory/network sparklines, swap, disk I/O, load, top processes (with TERM/KILL), listening ports, and systemd service management.
- **Docker management** — containers (with live CPU/MEM stats, SSE logs, exec shell), images, volumes, networks, Docker Compose editor, and automatic `sudo -n docker` fallback.
- **Multi-host batch operations** — execute commands or distribute files across multiple selected hosts in parallel with per-host result summaries.
- **Sudo file access** — edit root-owned files through `sudo` without leaving the browser (password prompted on demand, never stored).
- **Command broadcast** — type once and send the same input to every visible split pane.
- **AI assistant & agent** — natural-language Linux help, guided task execution with `pane_output` screen reading, per-connection command allowlist, optional Reviewer Model secondary approval, configurable tool-call/timeout caps, and prompt edit/retry.
- **Multiple AI providers** — OpenAI-compatible endpoints, Anthropic, Gemini and Ollama.
- **Security & governance** — SHA-256 host-key TOFU, AES-GCM credential encryption, TOTP 2FA login, multi-user RBAC (Admin / Operator / Viewer with connection scoping), and global operational audit logs.
- **Quick commands** — reusable shell snippets organised into groups with `{{var:default}}` template parameters and auto-execute toggle.
- **Themes and design tokens** — light, dark and system themes driven by a single token system.
- **Portable config** — import and export application configuration, including OpenSSH `config` import.

## Screenshots

<div align="center">
  <img src="docs/首页.png" alt="Terminal workspace" width="880" />
  <br /><br />
  <img src="docs/容器管理.png" alt="Docker container management" width="880" />
</div>

## Getting Started

Requires Node.js 20+.

```bash
npm install

# build the browser bundle, then start the web server on http://localhost:5080
npm run web
```

`npm run web` builds the renderer and launches `server/index.cjs`. For frontend-only
development, run `npm run dev:vite` for the Vite dev server against a running
`npm run web:only` backend.

## Docker / Web Deployment

```bash
docker compose up -d --build
```

Open <http://localhost:5080>. Set `AI_SSH_CLIENT_WEB_PORT` to change the host port.
From another device on the same LAN, open `http://<laptop-ip>:5080`; enable the
HTTPS listener (`AI_SSH_CLIENT_WEB_TLS=1`) if SFTP downloads must work from
non-localhost origins (browsers restrict the File System Access API to secure
contexts).

Common settings:

| Variable | Purpose |
| --- | --- |
| `AI_SSH_CLIENT_WEB_PORT` | Host port mapped to the container's `5080`. |
| `AI_SSH_CLIENT_WEB_PASSWORD` | Password for the web UI (passed to the container as `WEB_AUTH_PASSWORD`). |
| `AI_SSH_CLIENT_WEB_TLS` | `1` generates a self-signed certificate on first start (`WEB_TLS`). |
| `WEB_TLS_CERT` / `WEB_TLS_KEY` | Bring your own PEM certificate instead of self-signing. |
| `WEB_TLS_HOSTS` | Comma-separated hostnames / IPs for the self-signed certificate SAN. |
| `WEB_TLS_REGENERATE` | `1` forces regeneration of the self-signed certificate. |
| `WEB_HOST` | Bind address (`0.0.0.0` to expose on the network; already set under Docker). |
| `DATA_DIR` | Persistence directory (connections, settings, transfers, TLS material). |
| `WEB_SSH_TRUST_ON_FIRST_USE` | `true` to auto-trust hosts without a stored fingerprint. |
| `MCP_ALLOW_EXEC` | `1` enables MCP command execution (off by default). |

Certificates are stored in `DATA_DIR/tls/` and reused until they expire, the
volume is removed, or the browsed IP changes. To terminate TLS yourself, put a
reverse proxy (for example Caddy) in front of `127.0.0.1:5080`.

## Security

- **Host key verification** — every connection is checked against a stored
  SHA-256 fingerprint; unknown hosts prompt for trust-on-first-use.
- **Encrypted credentials** — SSH passwords, private keys and AI API keys are
  encrypted with AES-GCM before being written to disk (`server/secret-store.cjs`).
- **Password management** — pin the web password with `WEB_AUTH_PASSWORD`; the
  encryption key is derived from it. Changing or losing it makes previously
  stored secrets unreadable.
- **HTTPS for file downloads** — the File System Access API requires a secure
  context; use `WEB_TLS=1` or a TLS-terminating proxy for LAN access.

## MCP for AI Agents

`server/mcp/index.mjs` is an optional **stdio MCP server** exposing saved
Web-mode connections to MCP clients such as Claude Code, Cursor and DSH. The Web
gateway also serves a **Streamable HTTP endpoint at `/mcp`**
(`Authorization: Bearer <web password>`), so a client only needs the URL while
connections and policy stay server-side.

```bash
npm run mcp          # local stdio (needs access to the data directory)
npm run web          # gateway exposes http://<host>:5080/mcp
```

Command execution over MCP is disabled unless you enable it for the deployment
(`MCP_ALLOW_EXEC=1`).

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + F` | Terminal search |
| `Ctrl/Cmd + +` / `-` | Increase / decrease font size |
| `Esc` | Interrupt the running AI agent task |

## Tech Stack

- **Frontend** — React 18, TypeScript, Vite, Tailwind CSS (semantic design tokens), xterm.js, CodeMirror, Zustand.
- **Backend** — Node.js + Express, `ssh2` for SSH/SFTP, `ws` for terminals and streaming, SSE for container logs.
- **Storage** — JSON files under `DATA_DIR`, with AES-GCM encryption for secrets.

## Project Structure

```
server/             Node.js web server (SSH, SFTP, monitors, Docker, MCP, auth)
src/renderer/       React frontend (workspace, terminal, transfer, settings)
src/shared/         Shared types and IPC/API contracts
docs/               Screenshots and design documentation
scripts/            Build and design-system checks
test/               Vitest test suites
```

## Development

| Command | Description |
| --- | --- |
| `npm run dev:vite` | Frontend dev server |
| `npm run web:only` | Start the backend only |
| `npm run build:renderer` | Build the browser bundle |
| `npm run typecheck` | Type-check the frontend |
| `npm run test` | Run the Vitest suites |
| `npm run check` | Typecheck + tests + renderer build |
| `npm run mcp` | Start the stdio MCP server |

Run `npm run check` before opening a pull request.

## Data and Backups

State lives under `DATA_DIR` (default `./data`): `connections.json`,
`settings.json`, `sftp-transfers.json`, TLS material and the encrypted secret
store. Back up the whole directory — and keep `secret.key` (or the same
`WEB_AUTH_PASSWORD`) so encrypted credentials remain readable.

## Contributing

Issues and pull requests are welcome. Please keep changes focused, add tests for
behavioural changes, and run `npm run check` first.

## License

See [LICENSE](LICENSE).
