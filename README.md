# CC Remote

**Code from your couch.** CC Remote lets you control Claude Code on your workstation from your Android phone — browse project directories, start coding sessions, and chat with Claude over WebSocket. It's the ultimate tool for vibe coders who want to keep the flow going without being chained to a desk.

Got an idea while grabbing coffee? Pull out your phone, describe what you want, and Claude Code does the rest on your real dev machine. All you need is a network connection between your phone and workstation.

## How It Works

```
┌──────────────┐     WebSocket (JSON)     ┌────────────────┐     PTY     ┌──────────┐
│ Android App  │ ◄──────────────────────► │ Node.js Server │ ◄─────────► │  claude  │
│  (anywhere)  │     over LAN / VPN       │  (workstation) │            │   CLI    │
└──────────────┘                          └────────────────┘            └──────────┘
```

1. The **Node.js server** runs on your workstation, spawning `claude` CLI processes in pseudo-terminals
2. The **Android app** connects over WebSocket to list sessions, browse directories, and chat with Claude
3. Claude Code reads and writes files on your workstation just like it would if you were sitting at the keyboard

The chat interface renders Claude's Markdown responses — including tables, code blocks, and links — directly in the app. You describe what you want in natural language, Claude executes, and you see the results in real time.

## Remote Access with ZeroTier

The server listens on your local network by default. To access it from anywhere — a café, the office, or your couch — set up a virtual LAN with [ZeroTier](https://www.zerotier.com/):

1. **Create a ZeroTier network** at [my.zerotier.com](https://my.zerotier.com)
2. **Install ZeroTier** on your workstation and Android phone, then join both to your network
3. **Start the CC Remote server** — it binds to `0.0.0.0` by default, so it's reachable on the ZeroTier virtual interface too
4. **Configure the Android app** to use your workstation's ZeroTier IP (e.g. `10.147.17.x:11199`)

Now you can vibe code from literally anywhere with mobile data or Wi-Fi — your phone and workstation are on the same virtual LAN, as if they were in the same room. No port forwarding, no dynamic DNS, no exposing services to the public internet.

> **Pro tip:** ZeroTier is free for up to 25 devices. If you're behind a restrictive firewall, try [Tailscale](https://tailscale.com/) as an alternative — it uses WireGuard under the hood and works great with CC Remote too.

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

### Web Terminal (xterm.js)

The server includes a full-featured browser-based terminal powered by [xterm.js](https://xtermjs.org/). No need to install the Android app — just open a browser tab and you're in.

**What it can do:**

| Capability | Description |
|---|---|
| **Real-time PTY streaming** | Raw terminal output streamed via WebSocket — full ANSI colors, cursor movements, and interactive TUI apps |
| **Session dashboard** | Dropdown lists all active sessions with their directory and status (running / exited) |
| **Create sessions** | Enter a working directory and spawn a new Claude Code session with one click |
| **Directory browser** | Overlay file picker — navigate the server filesystem, select any directory with a visual tree |
| **Connect / Disconnect / Kill** | Full session lifecycle control from the toolbar |
| **Workspace-aware** | Respects the `workspace` config setting — pre-fills the workspace path and clamps directory browsing |
| **Connection status** | Live indicator shows connected (green) or disconnected (red) |
| **Keyboard input** | Direct keystroke forwarding to the PTY — type commands just like a local terminal |
| **Resizable** | Terminal auto-fills the browser window; resize the tab and it adapts |

**Access:** Open `http://<server-ip>:11199/terminal?token=<your-token>` in any modern browser. The auth token is printed to the server console on startup.

The web terminal is great for quick access from a laptop, pairing sessions with a teammate, or as a fallback when your phone isn't handy. It shares the same WebSocket protocol as the Android app, so you can even have both connected to the same session simultaneously.

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
