# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CC Remote** — remote Claude Code via Android. A two-component system: a Node.js WebSocket server that manages headless `claude` processes, and an Android client that connects to it over the local network. Each session is one long-lived `claude` process running in stream-json mode; the Android app lists active sessions and provides a chat UI to interact with them.

## Architecture

```
Android App (Java)  ←──WebSocket (JSON)──→  Node.js Server  ←──stream-json (stdio)──→  claude CLI
```

### Server (`server/`)
- `src/index.js` — HTTP server (health check `/health`, landing page `/`) + WebSocket server. Handles all client message routing via a `type`-based switch. Configuration loaded from `config.json`, overridable via env vars (`PORT`, `HOST`, `MAX_SESSIONS`, `WORKSPACE`, `PERMISSION_MODE`, `PERSIST_SESSIONS`, `SESSIONS_DIR`). On startup it bootstraps the active-profile overlay (`syncActiveSettings()` writes `profiles/active-settings.json`) and restores persisted sessions before accepting connections; on shutdown it saves all active sessions. **Profile switching is server-driven:** `switch_profile` writes the chosen profile's content to the private overlay (never `~/.claude/settings.json`), records the active id in `profiles/index.json` (the single source of truth), and calls `sessionManager.restartAll()` — it does not depend on any client sending `restart_session`. `list_profiles` reports `active` straight from `profiles/index.json`.
- `src/session-manager.js` — `SessionManager` class. Owns a `Map<id, ClaudeSession>`. Creates sessions, lists them, periodic cleanup of exited sessions with no clients (user-stopped sessions are exempt). `stopSession(id)` pauses a session — kills its process but keeps it in the map and persists a `stopped` flag so it survives a reboot as a resumable, paused session; `resumeSession(id)` relaunches it with `--resume`. `deleteSession(id)` permanently removes a session (stop + drop from map + purge its persisted file so it is not restored on reboot). `restartAll()` restarts every running session (used by server-driven profile switching). **Persistence:** when `persistSessions` is on, each session's state is written to `sessionsDir/<id>.json` (on turn completion via a debounced save, on exit, and every 30s as a safety net), and `restoreSessions()` reloads them on boot.
- `src/claude-session.js` — `ClaudeSession` extends `EventEmitter`. Spawns one long-lived `claude -p --input-format stream-json --output-format stream-json` process via `child_process.spawn` (no PTY). User turns are fed as NDJSON on stdin; the NDJSON event stream on stdout is parsed line-by-line into a per-turn state machine that broadcasts streaming text deltas, tool-call progress (`session_tool`), and final results. Keeps a rolling chat history (max 400 entries) for reconnect catch-up. `toJSON()`/`fromSaved()` serialize state to disk and resurrect a session with `--resume <id>` after a restart. **Stop/resume:** `stop()` pauses a session (kills the process, keeps history, marks `_stopped` which is persisted) and `resume()` relaunches it with `--resume`; a session saved while stopped is restored paused (not auto-started) so it stays stopped across reboots. `kill()` (used by delete + shutdown) is the hard variant — it detaches child/session listeners before terminating so the async `exit` event can't resave a just-deleted session. **Provider/profile control:** every launch passes `--settings <profiles/active-settings.json>` (CC Remote's PRIVATE overlay) so the process follows the active CC Remote profile; the launch `--model` is resolved fresh from that same file each start. The overlay is used instead of injecting env vars because `~/.claude/settings.json`'s `env` block overrides real process env vars, whereas `--settings` wins over it (verified empirically). `session_meta` (model/tools) is re-broadcast on every `system/init`, so a restart after a switch propagates the new model to clients. Exports `ACTIVE_SETTINGS_FILE`. Supports multi-client watching (multiple Android devices can view the same session).
- `src/cc-switch.js` — Read-only adapter for `~/.cc-switch/cc-switch.db` (SQLite). Reads Claude provider profiles via Node's built-in `node:sqlite` module. Exports `readCCSwitchProfiles()` (list) and `getCCSwitchProfile(id)` (deep-merges provider settings with common_config_claude base). The merged content is used to build CC Remote's private overlay on switch — CC Remote never writes the DB or `~/.claude/settings.json`. Zero npm dependencies.

### Android App (`android/`)
- `WebSocketManager.java` — Thread-safe singleton (DCL). OkHttp-based WebSocket client with exponential-ish backoff reconnect (max 10 attempts). Dispatches parsed JSON messages to listener lists. All callbacks run on the main thread via `Handler`.
- `MainActivity.java` — Session list screen. Pull-to-refresh triggers `list_sessions`. "New Session" dialog with workspace-aware directory picker and browser. Tap a session to open `TerminalActivity`.
- `TerminalActivity.java` — Chat-style terminal screen for one session. Uses RecyclerView with Markwon for Markdown rendering (including tables). Sends user input via `send_chat`, streams Claude's reply via `session_delta`, and shows transient tool-call indicators via `session_tool`. Tracks session lifecycle via foreground service callbacks. Loads locally-cached chat history (via `ChatHistoryStore`) on open for instant display, then lets the server's `chat_history` overwrite it as source of truth.
- `ChatAdapter.java` — RecyclerView adapter rendering user/Claude/tool messages (`TYPE_USER`/`TYPE_CLAUDE`/`TYPE_TOOL`). Markwon with TablePlugin for Markdown table rendering, cached for performance. Supports in-place streaming updates via payload rebind (`updateLastText`) and trailing tool-indicator cleanup (`removeTrailingTools`).
- `ChatHistoryStore.java` — Local mirror of each session's chat history in `{filesDir}/sessions/<id>.json`, matching the server's `[{role, text, ts}]` format. Enables offline browsing; the server remains source of truth and overwrites the cache when `chat_history` arrives.
- `ClawForegroundService.java` — Foreground service keeping WebSocket alive in background. Delivers `session_response` callbacks and reply notifications when app is in background.
- `SettingsActivity.java` — Server IP and port config, persisted via `PreferencesHelper`.
- `SessionAdapter.java` — RecyclerView adapter for the session list screen.
- `SessionInfo.java` / `ProfileInfo.java` — POJO models matching the server's session and profile JSON shapes. `ProfileInfo` has `source` (`"native"` or `"cc-switch"`), `model`, and `isCurrent` fields.
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
| C→S | `restart_session` | `session_id` — kills and relaunches the claude process to pick up the current model |
| C→S | `disconnect_session` | `session_id` |
| C→S | `stop_session` | `session_id` — stops (pauses) the session: terminates the claude process but keeps the session + its persisted state so it can be resumed. A stopped session stays stopped across a server restart |
| C→S | `resume_session` | `session_id` — relaunches a stopped session's claude process with `--resume` to restore context |
| C→S | `delete_session` | `session_id` — stops the session and purges its persisted state so it is NOT restored on the next server reboot |
| C→S | `server_info` | — |
| C→S | `list_directory` | `path` |
| C→S | `ping` | — |
| S→C | `session_list` | `sessions` (array of SessionInfo) |
| S→C | `session_created` | `session_id`, `directory`, `createdAt` |
| S→C | `session_connected` | `session_id`, `directory`, `status`, `exitCode` |
| S→C | `session_meta` | `session_id`, `claude_session_id`, `model`, `tools` (from claude's system/init) |
| S→C | `session_restarted` | `session_id` (ack for `restart_session`) |
| S→C | `session_output` | `session_id`, `data_raw` (string), `replay` (bool, optional) |
| S→C | `session_delta` | `session_id`, `text` (incremental streaming token chunk) |
| S→C | `session_tool` | `session_id`, `status` (`running`\|`done`), `name` (tool name, on `running`) |
| S→C | `session_response` | `session_id`, `data` (string), `is_error`, `cost_usd`, `duration_ms` (finalized turn text) |
| S→C | `session_killed` | `session_id` |
| S→C | `session_stopped` | `session_id` (session paused; resumable) |
| S→C | `session_resumed` | `session_id` (ack for `resume_session`; `session_meta` follows on init) |
| S→C | `session_deleted` | `session_id` (ack for `delete_session`) |
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

### CC Switch Integration

The server auto-discovers CC Switch profiles from `~/.cc-switch/cc-switch.db`. When the database is present, profiles are merged into `list_profiles` with `source: "cc-switch"` and shown as a read-only section in the Android profile picker.

**Switching never touches `~/.claude/settings.json`** (which would collide with the CC Switch desktop app and leave a running `claude` process with a model/endpoint mismatch — the historical cause of "model not found" after a switch). Instead, CC Remote deep-merges the common_config_claude base with the provider's settings_config and writes the result to its OWN private overlay file `server/profiles/active-settings.json`. Every `claude` process is launched with `--settings <that file>`, which overrides the user's global settings.json per-process (env-var injection does NOT work — settings.json's `env` block wins over real env vars; `--settings` wins over settings.json). On switch the server rebuilds the overlay and restarts all running sessions so they pick up the new provider/model atomically. CC Switch profiles cannot be created, renamed, or deleted through CC Remote — use CC Switch itself for that. The overlay file lives under the gitignored `server/profiles/` directory.

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
