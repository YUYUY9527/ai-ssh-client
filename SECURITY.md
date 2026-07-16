# Security Policy

AI SSH Client handles sensitive material: SSH credentials, private keys, and AI
API keys. We take security reports seriously.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately through one of these channels:

- GitHub's [private vulnerability reporting](https://github.com/YUYUY9527/ai-ssh-client/security/advisories/new)
  (preferred)
- Or email the maintainer via the address on the GitHub profile
  [@YUYUY9527](https://github.com/YUYUY9527)

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce
- Affected version(s) and platform
- Any suggested mitigation, if known

We aim to acknowledge reports within 5 business days and to provide a fix
timeline after triage. Please give us reasonable time to release a fix before
any public disclosure.

## How Sensitive Data Is Handled

Understanding the trust model helps when assessing a report:

- SSH passwords, private keys, passphrases, and AI API keys are stored
  separately from normal configuration data.
- On desktop, secrets are kept in the platform keyring (Windows Credential
  Manager where available); connection metadata lives in the local app data
  store.
- Private-key files are read only after explicit selection through the native
  file picker.
- The renderer reaches the backend only through the Tauri command bridge.
- Agent-driven command execution still passes through command risk checks and
  execution logging.

## Web Gateway

The optional Docker/web deployment runs a Node gateway that can open SSH
connections using stored credentials. It enforces access-token authentication:
every HTTP request and WebSocket connection must carry a valid session, and the
server binds to `127.0.0.1` by default (Docker Compose sets `0.0.0.0` inside the
container and controls the exposed host port).

Two things still need your attention:

- **The access token travels in plain text over HTTP.** For any deployment
  where traffic could be observed, terminate TLS in front of the gateway (a
  reverse proxy such as Caddy, Nginx, or Traefik). The session cookie is marked
  `Secure` automatically when the request arrives over HTTPS.
- **Use a strong token for shared deployments.** Set `WEB_AUTH_TOKEN`
  (`AI_SSH_CLIENT_WEB_TOKEN` in Compose) rather than relying on the
  auto-generated value when more than one person can reach the service.

Do not expose the gateway directly to an untrusted network without TLS. See the
Docker / Web Deployment section of the README for setup details.
