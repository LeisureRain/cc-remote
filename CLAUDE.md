# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CC Remote** — remote Claude Code via Android. A two-component system: a Node.js WebSocket server that manages Claude Code PTY sessions, and an Android client that connects to it over the local network. The server spawns `claude` CLI processes in pseudo-terminals; the Android app lists active sessions and provides a terminal UI to interact with them.

## Architecture

```
Android App (Java)  ←──WebSocket (JSON)──→  Node.js Server  ←──PTY──→  claude CLI
```

### Server (`server/`)
- `src/index.js` — HTTP server (health check `/health`, landing page `/`) + WebSocket server. Handles all client message routing via a `type`-based switch. Configuration loaded from `config.json`, overridable via env vars (`PORT`, `HOST`, `MAX_SESSIONS`, `WORKSPACE`).
- `src/session-manager.js` — `SessionManager` class. Owns a `Map<id, ClaudeSession>`. Creates sessions, lists them, kills them, periodic cleanup of exited sessions with no clients.
- `src/claude-session.js` — `ClaudeSession` extends `EventEmitter`. Spawns a shell PTY via `node-pty`, sends `claude\r` into it after 500ms. Maintains a rolling output buffer (max 5000 lines) for reconnection catch-up. Broadcasts output to all connected WebSocket clients. Supports multi-client watching (multiple Android devices can view the same session).

### Android App (`android/`)
- `WebSocketManager.java` — Thread-safe singleton (DCL). OkHttp-based WebSocket client with exponential-ish backoff reconnect (max 10 attempts). Dispatches parsed JSON messages to listener lists. All callbacks run on the main thread via `Handler`.
- `MainActivity.java` — Session list screen. Pull-to-refresh triggers `list_sessions`. "New Session" dialog with workspace-aware directory picker and browser. Tap a session to open `TerminalActivity`.
- `TerminalActivity.java` — Chat-style terminal screen for one session. Uses RecyclerView with Markwon for Markdown rendering (including tables). Sends user input via `send_chat`. Tracks session lifecycle via foreground service callbacks. Supports continue mode toggle.
- `ChatAdapter.java` — RecyclerView adapter rendering user/Claude messages. Markwon with TablePlugin for Markdown table rendering. Cached Markwon instance for performance.
- `ClawForegroundService.java` — Foreground service keeping WebSocket alive in background. Delivers `session_response` callbacks and reply notifications when app is in background.
- `SettingsActivity.java` — Server IP and port config, persisted via `PreferencesHelper`.
- `SessionAdapter.java` — RecyclerView adapter for the session list screen.
- `SessionInfo.java` — POJO model matching the server's session JSON shape.
- `ClawApplication.java` — `Application` subclass; initializes `PreferencesHelper` and `WebSocketManager`.

## WebSocket Protocol

All messages are JSON with a `type` field.

| Direction | Type | Key fields |
|---|---|---|
| C→S | `list_sessions` | — |
| C→S | `create_session` | `directory` (string, required) |
| C→S | `connect_session` | `session_id` |
| C→S | `send_input` | `session_id`, `text` |
| C→S | `send_chat` | `session_id`, `text`, `continue` (bool) |
| C→S | `disconnect_session` | `session_id` |
| C→S | `kill_session` | `session_id` |
| C→S | `server_info` | — |
| C→S | `list_directory` | `path` |
| C→S | `ping` | — |
| S→C | `session_list` | `sessions` (array of SessionInfo) |
| S→C | `session_created` | `session_id`, `directory`, `createdAt` |
| S→C | `session_connected` | `session_id`, `directory`, `status`, `exitCode` |
| S→C | `session_output` | `session_id`, `data_raw` (string), `replay` (bool, optional) |
| S→C | `session_response` | `session_id`, `data` (string) |
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

Configuration is loaded from `server/config.json` (default port 11199, host 0.0.0.0, max 20 sessions, workspace empty). Environment variables (`PORT`, `HOST`, `MAX_SESSIONS`, `WORKSPACE`) override the config file. When `workspace` is set to a non-empty path, directory browsing and session creation are restricted to that directory and its subdirectories (enforced server-side).

### Android
```bash
cd android
./gradlew assembleDebug     # Build debug APK
./gradlew installDebug      # Build and install to connected device/emulator
./gradlew test              # Run tests
./gradlew clean             # Clean build
```

The project targets API 26+ (Android 8.0), uses AndroidX, and requires Java 8.

## Key Dependencies

**Server:** `ws` (WebSocket), `node-pty` (pseudo-terminal, has native addon), `uuid` (session IDs).
**Android:** `OkHttp 4.9.3` (WebSocket client), `Gson` (JSON parsing), Material Components, AndroidX (appcompat, constraintlayout, recyclerview, swiperefreshlayout).

## Configuration

- **Server:** Config in `server/config.json` (port, host, maxSessions). The `gradle-local/` directory at the repo root is the Gradle distribution extracted from `gradle-bin.zip`, used by the Android build. Not related to the server.
- **Android network security:** Cleartext traffic is permitted globally (required for `ws://` to local servers). Configured in both `AndroidManifest.xml` (`usesCleartextTraffic="true"`) and `network_security_config.xml`.
- **Default server IP:** `192.168.1.100:11199` (set in `PreferencesHelper.java`).
