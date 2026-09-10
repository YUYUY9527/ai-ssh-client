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
- On the web gateway, secrets are encrypted at rest with AES-256-GCM before they
  reach `config.json` (see [Web Gateway](#web-gateway) for the exact threat
  model). All runtimes verify SSH host keys before authenticating.
- Private-key files are read only after explicit selection through the native
  file picker.
- The renderer reaches the backend only through the Tauri command bridge.
- Agent-driven command execution still passes through command risk checks and
  execution logging.

## SSH Host Key Verification

Every SSH connection is subject to trust-on-first-use (TOFU) host key
verification — this applies to the desktop app *and* to the web gateway, and to
"test connection" as well as real sessions.

- On first connect to a host, the app shows the key algorithm and SHA-256
  fingerprint and waits for you to accept or reject it (90-second timeout, then
  rejection).
- The accepted fingerprint is persisted. Later connections to the same host and
  port are silent only while the fingerprint *and* algorithm still match.
- If a host presents a different key, the app treats it as a possible
  man-in-the-middle: it shows both the previous and the new fingerprint and asks
  again. Rejecting leaves the original record untouched.

Fingerprints use the OpenSSH `SHA256:<base64>` format, so the string shown in
the desktop app can be compared directly with the one shown in the web UI and
with `ssh-keyscan` / `known_hosts` output.

For unattended web deployments with no browser attached, set
`WEB_SSH_TRUST_ON_FIRST_USE=true`: hosts that have no record yet are trusted
automatically and recorded, while a **changed** key is still rejected. Only
enable this if you accept first-use trust for new hosts.

## Web Gateway

The optional Docker/web deployment runs a Node gateway that can open SSH
connections using stored credentials. It enforces password authentication:
every HTTP request and WebSocket connection must carry a valid session, and the
server binds to `127.0.0.1` by default (Docker Compose sets `0.0.0.0` inside the
container and controls the exposed host port). The password is stored only as a
salted scrypt hash; the session cookie is derived from that hash, so changing
the password invalidates existing sessions.

### Credentials at rest

Connection passwords, private keys, passphrases, and AI API keys are encrypted
with AES-256-GCM before being written to `config.json`. The key comes from one
of two places:

| Mode | Key source | Protection |
| ---- | ---------- | ---------- |
| `WEB_AUTH_PASSWORD` set | scrypt-derived from that password | Key is **never written to disk**; a stolen data volume cannot be decrypted |
| otherwise (default) | random 32 bytes in `data/secret.key` (mode `0600`) | Protects against `config.json` being copied, committed, backed up, or dumped into logs — **not** against an attacker who can read the whole data directory |

The file mode is a deliberate tradeoff: the gateway must decrypt credentials
without a human present in order to open SSH sessions. Host filesystem
compromise is out of scope in both modes. Secrets are still returned to the
authenticated browser, which is what lets you view and edit a connection; the
encryption protects the data at rest, not the authenticated session.

Legacy plaintext `config.json` files keep working: values are read as-is and
re-encrypted on the next write, so no manual migration is needed. Changing
`WEB_AUTH_PASSWORD` (or deleting `secret.key`) makes existing ciphertext
undecryptable — affected connections show an empty password and must be filled
in again.

Three things still need your attention:

- **Change the default password immediately.** The gateway ships with the
  password `admin` on first start and shows a banner until you change it via
  **Settings → Password**. Anyone who can reach the service before you change it
  can sign in.
- **The password travels in plain text over HTTP.** For any deployment where
  traffic could be observed, terminate TLS in front of the gateway (a reverse
  proxy such as Caddy, Nginx, or Traefik). The session cookie is marked `Secure`
  automatically when the request arrives over HTTPS.
- **Pin a strong password for shared deployments.** Set `WEB_AUTH_PASSWORD`
  (`AI_SSH_CLIENT_WEB_PASSWORD` in Compose) to manage the password through
  configuration; in this mode it is never written to disk and cannot be changed
  from the UI.

Do not expose the gateway directly to an untrusted network without TLS. See the
Docker / Web Deployment section of the README for setup details.
