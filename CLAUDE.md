# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CC Remote** — remote Claude Code via Android. A two-component system: a Node.js WebSocket server that manages headless `claude` processes, and an Android client that connects to it over the local network. Each session is one long-lived `claude` process running in stream-json mode; the Android app lists active sessions and provides a chat UI to interact with them.

## Architecture

```
Android App (Java)  ←──WebSocket (JSON)──→  Node.js Server  ←──stream-json (stdio)──→  claude CLI
```

### Server (`server/`)
- `src/index.js` — HTTP server (health check `/health`, landing page `/`) + WebSocket server. Handles all client message routing via a `type`-based switch. Configuration loaded from `config.json`, overridable via env vars (`PORT`, `HOST`, `MAX_SESSIONS`, `WORKSPACE`, `PERMISSION_MODE`, `PERSIST_SESSIONS`, `SESSIONS_DIR`). On startup it restores persisted sessions before accepting connections; on shutdown it saves all active sessions.
- `src/session-manager.js` — `SessionManager` class. Owns a `Map<id, ClaudeSession>`. Creates sessions, lists them, kills them, periodic cleanup of exited sessions with no clients. **Persistence:** when `persistSessions` is on, each session's state is written to `sessionsDir/<id>.json` (on turn completion via a debounced save, on exit, and every 30s as a safety net), and `restoreSessions()` reloads them on boot.
- `src/claude-session.js` — `ClaudeSession` extends `EventEmitter`. Spawns one long-lived `claude -p --input-format stream-json --output-format stream-json` process via `child_process.spawn` (no PTY). User turns are fed as NDJSON on stdin; the NDJSON event stream on stdout is parsed line-by-line into a per-turn state machine that broadcasts streaming text deltas, tool-call progress (`session_tool`), and final results. Keeps a rolling chat history (max 400 entries) for reconnect catch-up. `toJSON()`/`fromSaved()` serialize state to disk and resurrect a session with `--resume <id>` after a restart; the launch model is resolved fresh from `~/.claude/settings.json` each start so a resumed session follows the active profile rather than a stale pinned model. Supports multi-client watching (multiple Android devices can view the same session).

### Android App (`android/`)
- `WebSocketManager.java` — Thread-safe singleton (DCL). OkHttp-based WebSocket client with exponential-ish backoff reconnect (max 10 attempts). Dispatches parsed JSON messages to listener lists. All callbacks run on the main thread via `Handler`.
- `MainActivity.java` — Session list screen. Pull-to-refresh triggers `list_sessions`. "New Session" dialog with workspace-aware directory picker and browser. Tap a session to open `TerminalActivity`.
- `TerminalActivity.java` — Chat-style terminal screen for one session. Uses RecyclerView with Markwon for Markdown rendering (including tables). Sends user input via `send_chat`, streams Claude's reply via `session_delta`, and shows transient tool-call indicators via `session_tool`. Tracks session lifecycle via foreground service callbacks. Loads locally-cached chat history (via `ChatHistoryStore`) on open for instant display, then lets the server's `chat_history` overwrite it as source of truth.
- `ChatAdapter.java` — RecyclerView adapter rendering user/Claude/tool messages (`TYPE_USER`/`TYPE_CLAUDE`/`TYPE_TOOL`). Markwon with TablePlugin for Markdown table rendering, cached for performance. Supports in-place streaming updates via payload rebind (`updateLastText`) and trailing tool-indicator cleanup (`removeTrailingTools`).
- `ChatHistoryStore.java` — Local mirror of each session's chat history in `{filesDir}/sessions/<id>.json`, matching the server's `[{role, text, ts}]` format. Enables offline browsing; the server remains source of truth and overwrites the cache when `chat_history` arrives.
- `ClawForegroundService.java` — Foreground service keeping WebSocket alive in background. Delivers `session_response` callbacks and reply notifications when app is in background.
- `SettingsActivity.java` — Server IP and port config, persisted via `PreferencesHelper`.
- `SessionAdapter.java` — RecyclerView adapter for the session list screen.
- `SessionInfo.java` — POJO model matching the server's session JSON shape.
- `ClawApplication.java` — `Application` subclass; initializes `PreferencesHelper`, `ChatHistoryStore`, and `WebSocketManager`.

## WebSocket Protocol

All messages are JSON with a `type` field.

| Direction | Type | Key fields |
|---|---|---|
| C→S | `list_sessions` | — |
| C→S | `create_session` | `directory` (string, required) |
| C→S | `connect_session` | `session_id` |
| C→S | `send_input` | `session_id`, `text` |
| C→S | `send_chat` | `session_id`, `text` (`continue` accepted but ignored — the persistent process always continues) |
| C→S | `disconnect_session` | `session_id` |
| C→S | `kill_session` | `session_id` |
| C→S | `server_info` | — |
| C→S | `list_directory` | `path` |
| C→S | `ping` | — |
| S→C | `session_list` | `sessions` (array of SessionInfo) |
| S→C | `session_created` | `session_id`, `directory`, `createdAt` |
| S→C | `session_connected` | `session_id`, `directory`, `status`, `exitCode` |
| S→C | `session_meta` | `session_id`, `claude_session_id`, `model`, `tools` (from claude's system/init) |
| S→C | `session_output` | `session_id`, `data_raw` (string), `replay` (bool, optional) |
| S→C | `session_delta` | `session_id`, `text` (incremental streaming token chunk) |
| S→C | `session_tool` | `session_id`, `status` (`running`\|`done`), `name` (tool name, on `running`) |
| S→C | `session_response` | `session_id`, `data` (string), `is_error`, `cost_usd`, `duration_ms` (finalized turn text) |
| S→C | `session_killed` | `session_id` |
| S→C | `session_exited` | `session_id`, `exit_code` |
| S→C | `chat_history` | `session_id`, `entries` (array), `pending` (string\|null) |
| S→C | `server_info` | `os`, `homeDir`, `pathSeparator`, `commonPaths`, `workspace` |
| S→C | `directory_list` | `path`, `parent`, `entries` |
| S→C | `error` | `message` |
| S→C | `pong` | — |

## Commands

### Server
```bash
cd server
npm start              # Start server (default port 11199)
npm run dev            # Start with --watch for auto-reload
```

Configuration is loaded from `server/config.json` (default port 11199, host 0.0.0.0, max 20 sessions, workspace empty, `persistSessions: true`, `sessionsDir: "sessions"`). Environment variables (`PORT`, `HOST`, `MAX_SESSIONS`, `WORKSPACE`, `PERMISSION_MODE`, `PERSIST_SESSIONS`, `SESSIONS_DIR`) override the config file. When `workspace` is set to a non-empty path, directory browsing and session creation are restricted to that directory and its subdirectories (enforced server-side). When `persistSessions` is on, session state is written to `sessionsDir` (gitignored) and restored on restart via `--resume`.

### Android
```bash
cd android
./gradlew assembleDebug     # Build debug APK
./gradlew installDebug      # Build and install to connected device/emulator
./gradlew test              # Run tests
./gradlew clean             # Clean build
```

The project targets API 26+ (Android 8.0), uses AndroidX, and requires Java 8.

## Development Workflow

**Commit as soon as a change is complete (改完即提交).** Do not leave finished work sitting uncommitted in the working tree — once a logical change is done and sanity-checked, commit it immediately rather than waiting to be asked. This overrides the default "only commit when asked" behavior for this repo.

- **Commit directly to `master`.** This is a solo project with a linear history; do not create feature branches unless explicitly requested.
- **Group commits by component/feature.** Split a batch into coherent commits (e.g. `feat(server)`, `feat(android)`, `docs`) rather than one mega-commit.
- **Conventional Commit messages.** Use `type(scope): summary` — e.g. `feat(server)`, `feat(android)`, `fix(android)`, `chore`, `docs`, `refactor`. End each message with the `Co-Authored-By` trailer.
- **Keep CLAUDE.md current.** When a change alters architecture, the WebSocket protocol, config keys, or adds/removes a component, update this file in the same batch.
- Pushing to `origin` is not automatic — push only when the user asks.

## Key Dependencies

**Server:** `ws` (WebSocket), `uuid` (session IDs). (`node-pty` remains in `package.json` but is no longer used — sessions run headless `claude` via `child_process`, not a PTY.)
**Android:** `OkHttp 4.9.3` (WebSocket client), `Gson` (JSON parsing), Material Components, AndroidX (appcompat, constraintlayout, recyclerview, swiperefreshlayout).

## Configuration

- **Server:** Config in `server/config.json` (port, host, maxSessions). The `gradle-local/` directory at the repo root is the Gradle distribution extracted from `gradle-bin.zip`, used by the Android build. Not related to the server.
- **Android network security:** Cleartext traffic is permitted globally (required for `ws://` to local servers). Configured in both `AndroidManifest.xml` (`usesCleartextTraffic="true"`) and `network_security_config.xml`.
- **Default server IP:** `192.168.1.100:11199` (set in `PreferencesHelper.java`).
