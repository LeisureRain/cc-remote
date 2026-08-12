# Project

## Purpose

CC Remote is a remote coding-control system for running local AI coding agents from an Android phone. The workstation runs a Node.js HTTP/WebSocket server that manages coding-agent sessions, while the Android client connects over LAN, VPN, or tunnel to browse directories, create sessions, and chat with agents.

The repository also includes a Windows WinForms launcher that starts and monitors the server without requiring users to run terminal commands directly.

## Product Concepts

- Server: local workstation process exposing HTTP health/status and WebSocket JSON commands.
- Session: a long-lived logical coding-agent session with persisted chat/history state.
- Agent adapters: support for Claude Code, Codex CLI, and OpenCode via separate server session classes.
- Android client: Java app for session list, settings, chat, directory browsing, background service, and notifications.
- Provider profiles: server-managed local profiles plus read-only CC Switch profile discovery.
- Windows launcher: single-file .NET Framework 4.8 GUI that embeds/extracts the server bundle and controls the server process.
- Version: repo-root `VERSION` is the human-facing version source synchronized into server, Android, and launcher files.

## Primary Workflows

- Start the server from `server/` with `npm start`, then connect from Android over `ws://<host>:11199` using the generated auth token.
- Create, connect, stop, resume, delete, and watch sessions from the Android app.
- Switch provider/profile and per-session model through the app; the server rebuilds a private profile overlay and restarts running sessions when needed.
- Package release artifacts from the repository root:
  - `node package-android.mjs` writes signed APKs to `dist/cc-remote-v<VERSION>.apk`.
  - `node package-win.mjs` writes Windows launcher artifacts to `dist/CCRemoteLauncher-v<VERSION>.exe`.

## Important Dependencies

- Server runtime: Node.js 18+; Node 22+ recommended for built-in `node:sqlite` CC Switch discovery.
- Agent CLIs on server PATH: `claude`, optionally `codex` and `opencode`.
- Server npm packages: `ws`, `uuid`.
- Android: Java Android app, Android Gradle Plugin 8.2.2, Gradle 8.4 wrapper, AndroidX, Material Components, OkHttp, Gson, Markwon.
- Windows launcher: .NET Framework 4.8 target, WinForms, build-time `Microsoft.NETFramework.ReferenceAssemblies`.
- Packaging helpers: root Node scripts and `tools/`.

## Assumptions To Confirm

- The repository is intentionally developed directly on `master` as documented in `CLAUDE.md`.
- Root `package.json`, `package-lock.json`, and `scripts/` are intentionally tracked despite `.gitignore` entries that also list them.
- `CLAUDE.md` is the authoritative architectural and workflow guide for this repository unless superseded by user instructions.
