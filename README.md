# CC Remote

Remote Claude Code via Android. Browse directories, start Claude Code sessions, and chat with Claude — all from your Android device over the local network.

## Architecture

```
Android App  ←──WebSocket (JSON)──→  Node.js Server  ←──PTY──→  claude CLI
```

The Node.js server runs on your workstation, spawning `claude` CLI processes in pseudo-terminals. The Android app connects over WebSocket to list, create, and interact with sessions.

## Features

- **Session management** — create, list, connect, and kill Claude Code sessions
- **Markdown rendering** — full Markdown support including tables, code blocks, and links
- **Workspace restriction** — optionally lock the server to a specific directory tree
- **Directory browser** — browse the server filesystem from the Android app to pick a working directory
- **Background persistence** — foreground service keeps the WebSocket connection alive even when the app is in the background
- **Reply notifications** — get notified when Claude responds while the app is in the background
- **Continue mode toggle** — choose whether to pass `--continue` to `claude -p`
- **Multi-client watching** — multiple Android devices can view the same session simultaneously
- **Web terminal** — built-in xterm.js browser terminal at `/terminal`

## Quick Start

### Server

```bash
cd server
npm install
npm start
```

The server starts on `http://0.0.0.0:11199` by default. Open `http://<server-ip>:11199` in a browser for the web terminal and health check.

### Android

Open the `android/` directory in Android Studio, or build from the command line:

```bash
cd android
./gradlew assembleDebug
```

Install the APK on your device. Configure the server IP and port in Settings (default port **11199**).

## Configuration

Edit `server/config.json`:

```json
{
  "port": 11199,
  "host": "0.0.0.0",
  "maxSessions": 20,
  "workspace": ""
}
```

| Field | Description |
|---|---|
| `port` | HTTP/WebSocket listen port |
| `host` | Bind address (`0.0.0.0` for LAN access) |
| `maxSessions` | Maximum concurrent Claude Code sessions |
| `workspace` | If set, restricts directory browsing and session creation to this path and its subdirectories |

Environment variables (`PORT`, `HOST`, `MAX_SESSIONS`, `WORKSPACE`) override the config file.

## WebSocket Protocol

All messages are JSON with a `type` field. See [CLAUDE.md](CLAUDE.md) for the full protocol table.

## Requirements

**Server:** Node.js 18+, `claude` CLI installed and in PATH.

**Android:** API 26+ (Android 8.0).

## License

MIT
