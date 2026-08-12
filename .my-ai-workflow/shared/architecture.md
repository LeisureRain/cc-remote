# Architecture

## Stack

- Server: CommonJS Node.js HTTP/WebSocket service in `server/src/`.
- Android: Java Android application in `android/app/src/main/java/com/romp/ccremote/`.
- Windows launcher: C# WinForms .NET Framework 4.8 application in `launcher/`.
- Packaging and tooling: Node.js ES modules at the repository root and under `tools/`.

## Runtime Structure

```text
Android app <-> WebSocket JSON <-> Node.js server <-> local agent CLI processes
Windows launcher -> starts/stops Node.js server and polls /health
```

The server owns the canonical session state. Android mirrors chat history locally for fast/offline viewing, but server `chat_history` is the source of truth.

## Server Modules

- `server/src/index.js`: HTTP server, WebSocket server, config loading, auth token handling, profile management, message routing, `/health`, and session-manager startup/shutdown.
- `server/src/session-manager.js`: session map, lifecycle operations, restart-all, cleanup, persistence save/restore.
- `server/src/agent-registry.js`: supported agent definitions and factory/restore/model-list helpers for Claude, Codex, and OpenCode.
- `server/src/claude-session.js`: long-lived `claude -p` stream-json process adapter, streaming parser, tool/thinking events, profile overlay usage, session serialization.
- `server/src/codex-session.js`: `codex exec --json` per-turn adapter with Codex session resume support.
- `server/src/opencode-session.js`: `opencode run --format json` per-turn adapter with OpenCode session resume support and isolated OpenCode config/data directories.
- `server/src/cc-switch.js`: read-only CC Switch SQLite profile adapter.

## Android Modules

- `WebSocketManager.java`: OkHttp WebSocket singleton, reconnect behavior, JSON dispatch.
- `MainActivity.java`: session list and new-session flow.
- `TerminalActivity.java`: chat UI, streaming updates, tool activity, interruption, session lifecycle UI.
- `ChatAdapter.java`: RecyclerView rendering for user/agent/tool messages with Markwon.
- `ChatHistoryStore.java`: local session history cache under app files.
- `ClawForegroundService.java`: background WebSocket persistence and reply notifications.
- `SettingsActivity.java`, `PreferencesHelper.java`: server connection settings.
- `SessionInfo.java`, `ProfileInfo.java`, `ChatMessage.java`: client-side data models.

## Windows Launcher Modules

- `Program.cs`: single-instance startup.
- `MainForm.cs`: server process control, live log, `/health` polling, read-only session list, settings entry point.
- `SettingsForm.cs`: edit port and workspace in server `config.json`.
- `ServerLocator.cs`: extract embedded server bundle to `%LOCALAPPDATA%\CC-Remote\server`, preserve user config, locate dev server folder when unbundled.

## Data Flow

- Clients send JSON messages with a `type` field over WebSocket.
- The server authenticates WebSocket connections with the generated token from `server/.cc-remote-token`.
- The server creates or restores agent sessions and forwards user turns to the active adapter.
- Adapters parse agent output and broadcast session deltas, final responses, tool activity, model metadata, and history.
- Session state is persisted under `sessionsDir` when enabled.
- Provider profiles are stored under `server/profiles/`; CC Switch profiles are read from `~/.cc-switch/cc-switch.db` without writes.

## Deployment And Packaging

- Android release packaging runs from the repository root via `node package-android.mjs`.
- Windows launcher packaging runs from the repository root via `node package-win.mjs`.
- `tools/sync-version.mjs` synchronizes root `VERSION` into server, launcher, and Android version fields.
- `tools/build-server-bundle.mjs` stages server source and production dependencies, then creates `launcher/server-bundle.zip`.

## Assumptions To Confirm

- Session persistence and profile directories are intentionally untracked local runtime state.
- The Windows launcher should remain English-only as documented in `CLAUDE.md`.
