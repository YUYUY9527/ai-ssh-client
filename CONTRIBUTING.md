# Contributing to AI SSH Client

Thanks for taking the time to contribute. This guide covers how to get set up,
the checks we expect to pass, and how to submit changes.

## Getting Started

Prerequisites:

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- Platform build dependencies for [Tauri 2](https://tauri.app/start/prerequisites/)

Install and run:

```bash
npm install
npm run dev
```

## Project Layout

```text
src-tauri/   # Tauri/Rust backend: SSH, SFTP, AI, agent, storage services
src/renderer # React + TypeScript UI, organized by domain (session, transfer, ...)
src/shared   # Shared types and constants
server/      # Optional Node web gateway (Docker deployment)
scripts/     # Node-based verification scripts
docs/         # Architecture notes
```

The frontend is organized around a session-centric workspace architecture.
See [docs/refactor-blueprint.md](docs/refactor-blueprint.md) for the design
rationale before making structural changes.

## Before You Open a Pull Request

Run the full check suite and make sure it passes:

```bash
npm run check       # typecheck + UI/SFTP/terminal script tests + renderer build
npm run test:rust   # cargo test for the Rust backend
```

Guidelines:

- Keep changes focused. One logical change per pull request.
- Match the surrounding code style, naming, and idioms.
- Add or update tests for behavior changes.
- Update the README and relevant docs when behavior or setup changes.
- Do not commit secrets, `.env` files, or private keys.

## Commit Messages

Write clear, descriptive commit messages. The existing history mixes Chinese and
English; either is fine, but be specific about what changed and why.

## Branches and PRs

- Branch from `master`.
- Push to a feature branch, never directly to `master`.
- Open a pull request against `master` and fill in the template.
- Link any related issues.

## Reporting Bugs and Requesting Features

Use the issue templates. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of Conduct

By participating you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).
