# CC Remote

**Code from your couch.** CC Remote lets you drive Claude Code on your workstation from your Android phone — browse project directories, start coding sessions, switch AI providers, and chat with Claude over WebSocket. It's the ultimate tool for vibe coders who want to keep the flow going without being chained to a desk.

Got an idea while grabbing coffee? Pull out your phone, describe what you want, and Claude Code does the rest on your real dev machine. All you need is a network connection between your phone and your workstation.

> English | [中文](README_CN.md)

## Screenshots

| Sessions | Start a session | Chat |
|:---:|:---:|:---:|
| ![Session list](screenshots/home.jpg) | ![Start Claude Code](screenshots/start-session.jpg) | ![Chat](screenshots/chat.jpg) |
| **Provider / model picker** | **Server settings** | |
| ![Profiles](screenshots/profiles.jpg) | ![Server settings](screenshots/server-settings.jpg) | |

**Windows launcher** — one-click server control with a live log and a read-only session list:

![Windows launcher](screenshots/windows.png)

## How It Works

```
┌──────────────┐     WebSocket (JSON)     ┌────────────────┐   stream-json   ┌──────────┐
│ Android App  │ ◄──────────────────────► │ Node.js Server │ ◄────(stdio)───► │  claude  │
│  (anywhere)  │     over LAN / VPN       │  (workstation) │                 │   CLI    │
└──────────────┘                          └────────────────┘                 └──────────┘
```

1. The **Node.js server** runs on your workstation. Each session is one long-lived `claude -p` process in stream-json mode (headless, no PTY) — user turns go in as NDJSON on stdin, and Claude's streaming events come back on stdout.
2. The **Android app** connects over WebSocket to list sessions, browse directories, switch providers, and chat with Claude.
3. Claude Code reads and writes files on your workstation just like it would if you were sitting at the keyboard.

The chat interface renders Claude's Markdown responses — including tables, code blocks, and links — directly in the app. You describe what you want in natural language, Claude executes, and you see the streaming result in real time. Sessions are persistent: they survive a server restart and resume with full context via `--resume`.

## Remote Access with ZeroTier

The server listens on your local network by default. To access it from anywhere — a café, the office, or your couch — set up a virtual LAN with [ZeroTier](https://www.zerotier.com/):

1. **Create a ZeroTier network** at [my.zerotier.com](https://my.zerotier.com)
2. **Install ZeroTier** on your workstation and Android phone, then join both to your network
3. **Start the CC Remote server** — it binds to `0.0.0.0` by default, so it's reachable on the ZeroTier virtual interface too
4. **Configure the Android app** to use your workstation's ZeroTier IP (e.g. `10.147.17.x:11199`)

Now you can vibe code from literally anywhere with mobile data or Wi-Fi — your phone and workstation are on the same virtual LAN, as if they were in the same room. No port forwarding, no dynamic DNS, no exposing services to the public internet.

> **Pro tip:** ZeroTier is free for up to 25 devices.

### Other ways to connect

ZeroTier is just the easiest option — **anything that puts your phone and workstation on the same reachable network works.** Pick whatever you already have:

- **Same Wi-Fi / LAN** — no setup at all; just point the app at the workstation's local IP (this is the default).
- **Tailscale** — a WireGuard-based mesh VPN with a similar zero-config experience; great if you're behind a restrictive firewall.
- **Self-hosted VPN** — WireGuard or OpenVPN, if you already run one.
- **Reverse tunnel** — [frp](https://github.com/fatedier/frp), [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/), or ngrok to relay the port out through a public endpoint.
- **SSH port forwarding** — `ssh -L 11199:localhost:11199 user@workstation` if you already have SSH access to the machine.

> **⚠️ Security:** the connection is gated by the auto-generated **auth token**, but if you expose the port through a public relay (reverse tunnel / port forward), keep the token on and prefer a method that adds its own encryption/auth (VPN, Cloudflare Tunnel). Don't put a raw, unauthenticated port on the open internet.

## Features

- **Session management** — create, list, connect, stop/resume, and delete Claude Code sessions; multiple sessions run concurrently
- **Persistent sessions** — sessions survive a server restart and resume with full context (`--resume`); a paused session stays paused across reboots
- **Provider & model switching** — switch the AI provider/model your sessions use on the fly, straight from the app, with automatic [CC Switch](https://github.com/farion1231/cc-switch) profile discovery
- **Markdown rendering** — full Markdown support including tables, code blocks, and links
- **Live activity view** — a status bar shows what Claude is doing right now (thinking / running a tool with its arguments / writing) with an elapsed-time counter that stays accurate across reconnects and backgrounding; it turns amber if a turn goes silent so a hang is distinguishable from a long step, and lets you interrupt at any point in the turn. Tool calls leave a browsable `⚙ name · detail` trail in the chat, each annotated with a `→ output snippet` once the tool finishes (shown in red on error)
- **Workspace restriction** — optionally lock the server to a specific directory tree
- **Directory browser** — browse the server filesystem from the Android app to pick a working directory, with recent paths and quick paths
- **Background persistence** — a foreground service keeps the WebSocket connection alive even when the app is in the background
- **Reply notifications** — get notified when Claude responds while the app is in the background
- **Auth token** — every connection is gated by an auto-generated token, so a session on your LAN/VPN isn't open to anyone who finds the port
- **Multi-client watching** — multiple Android devices can view the same session simultaneously
- **Windows launcher** — a single-exe GUI to run the server with no terminal, with a live log and a read-only session list

## Quick Start

### Server

```bash
cd server
npm install
npm start
```

The server starts on `http://0.0.0.0:11199` by default. Open `http://<server-ip>:11199` in a browser for a simple status / health-check page. On first run it prints (and persists) an **auth token** — you'll enter this in the Android app's Server Settings.

#### Windows: one-click launcher

For non-technical Windows users there's a tiny GUI launcher (`launcher/`). The **entire server is
embedded inside a single ~160 KB exe** (extracted to `%LOCALAPPDATA%\CC-Remote` on first run) — users
download one file, no folder, no runtime install (targets the built-in .NET Framework 4.8). It
starts/stops/restarts the server process, shows its log live, and mirrors the active session list.
Build it with:

```bash
node package-win.mjs   # -> dist/CCRemoteLauncher-v<VERSION>.exe  (ship this one file)
```

The target machine just needs Node.js + the `claude` CLI on PATH (the exe drives the local `claude`,
it doesn't replace it). See `launcher/README.md` for details.

### Android

Open the `android/` directory in Android Studio, or build from the command line:

```bash
cd android
./gradlew assembleDebug
```

Or build the signed release APK straight into `dist/` from the repo root:

```bash
node package-android.mjs   # -> dist/cc-remote-v<VERSION>.apk
```

Install the APK on your device. In **Settings**, set the server IP, port (default **11199**), and the auth token printed by the server.

> **⚠️ Important for background notifications:** To receive Claude's replies when the app is in the background:
> 1. **Notification access** — On first launch, Android will ask for notification permission. Tap "Allow". If you skipped it, go to **Settings → Apps → CC Remote → Notifications** and enable all notification channels. Without this, reply notifications will be **silent** (no sound/vibration).
> 2. **Battery optimization** — Go to **Settings → Apps → CC Remote → Battery → Unrestricted** (or disable battery optimization). Many Chinese ROMs (MIUI, ColorOS, EMUI, etc.) aggressively kill background services by default — without this exception, the foreground service will be killed and you'll miss notifications.

## Configuration

Edit `server/config.json`:

```json
{
  "port": 11199,
  "host": "0.0.0.0",
  "maxSessions": 20,
  "workspace": "",
  "persistSessions": true,
  "sessionsDir": "sessions"
}
```

| Field | Description |
|---|---|
| `port` | HTTP/WebSocket listen port |
| `host` | Bind address (`0.0.0.0` for LAN access) |
| `maxSessions` | Maximum concurrent Claude Code sessions |
| `workspace` | If set, restricts directory browsing and session creation to this path and its subdirectories |
| `persistSessions` | Persist session state to disk and restore it on restart |
| `sessionsDir` | Directory (relative to `server/`) where persisted session state is written |

Environment variables (`PORT`, `HOST`, `MAX_SESSIONS`, `WORKSPACE`, `PERMISSION_MODE`, `PERSIST_SESSIONS`, `SESSIONS_DIR`) override the config file. The auth token is auto-generated on first run and stored in `server/.cc-remote-token`.

## Provider Profiles & CC Switch Integration

CC Remote can switch the **AI provider and model** your Claude Code sessions run on — straight from the app, without ever touching your global `~/.claude/settings.json`. Tap the profile chip at the top of the session list, pick a profile, and confirm: the server rebuilds its private settings overlay and restarts running sessions so they pick up the new provider/model atomically (the new model then shows up in the app).

### Two profile sources

- **Local** — profiles you create in the app: a name plus a `settings.json` JSON snippet (e.g. a `model` and a provider `env` block with `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`). Fully managed from CC Remote — create, rename, switch, delete.
- **CC Switch** — if you use the [CC Switch](https://github.com/farion1231/cc-switch) desktop app, CC Remote auto-discovers its Claude provider profiles from `~/.cc-switch/cc-switch.db` (read-only, via Node's built-in `node:sqlite`). They show up in a separate section of the picker and can be switched to, but **not** edited here — manage those in CC Switch itself.

### How switching works (and why it's safe)

- **It never writes `~/.claude/settings.json`.** Overwriting the shared global file would collide with the CC Switch desktop app and leave a running `claude` stuck on a mismatched model/endpoint — the historical cause of "model not found" after a switch. Instead, CC Remote deep-merges the chosen profile into its **own private overlay** at `server/profiles/active-settings.json` and launches every `claude` process with `--settings <that file>`.
- **`--settings`, not environment variables.** Injecting `ANTHROPIC_BASE_URL` into the child process's env does *not* work, because a `settings.json` `env` block overrides real process env vars. `--settings` is a high-precedence overlay that *wins* over `settings.json` (verified empirically) — that's what makes per-process provider switching actually take effect.
- **Single source of truth.** The active profile is recorded in `server/profiles/index.json`. On switch, the server rebuilds the overlay, updates the index, and restarts all running sessions; the fresh model propagates back to the app via the `session_meta` message. Switching is server-driven — it doesn't depend on which client screen happens to be open.

> The `server/profiles/` directory (overlay + local profiles) is gitignored — your tokens stay on your machine. CC Switch profiles cannot be created, renamed, or deleted through CC Remote; use CC Switch for that.

## WebSocket Protocol

All messages are JSON with a `type` field. See [CLAUDE.md](CLAUDE.md) for the full protocol table.

## Requirements

**Server:** Node.js 18+ (with built-in `node:sqlite` for CC Switch discovery — Node 22+ recommended), `claude` CLI installed and in PATH.

**Android:** API 26+ (Android 8.0).

**Windows launcher:** .NET Framework 4.8 (built into Windows 10 1903+/11), plus Node.js + `claude` on PATH.

## License

MIT
