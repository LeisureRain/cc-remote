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

- **Session management** — create, list, connect, stop/resume, and delete Claude Code sessions
- **Provider & model switching** — switch the AI provider/model your sessions use on the fly, with automatic [CC Switch](https://github.com/farion1231/cc-switch) profile discovery
- **Markdown rendering** — full Markdown support including tables, code blocks, and links
- **Workspace restriction** — optionally lock the server to a specific directory tree
- **Directory browser** — browse the server filesystem from the Android app to pick a working directory
- **Background persistence** — foreground service keeps the WebSocket connection alive even when the app is in the background
- **Reply notifications** — get notified when Claude responds while the app is in the background
- **Continue mode toggle** — choose whether to pass `--continue` to `claude -p`
- **Multi-client watching** — multiple Android devices can view the same session simultaneously

## Quick Start

### Server

```bash
cd server
npm install
npm start
```

The server starts on `http://0.0.0.0:11199` by default. Open `http://<server-ip>:11199` in a browser for a simple status / health-check page.

#### Windows: one-click launcher

For non-technical Windows users there's a tiny GUI launcher (`launcher/`, ~15 KB exe, targets the
built-in .NET Framework 4.8 — no runtime install). It starts/stops/restarts the server process and
shows its log live. Build a ready-to-ship folder with:

```bash
node tools/package-win.mjs   # -> dist/CC-Remote-Server/  (zip and share)
```

The target machine just needs Node.js + the `claude` CLI on PATH. See `launcher/README.md` for details.

### Android

Open the `android/` directory in Android Studio, or build from the command line:

```bash
cd android
./gradlew assembleDebug
```

Install the APK on your device. Configure the server IP and port in Settings (default port **11199**).

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

**Server:** Node.js 18+, `claude` CLI installed and in PATH.

**Android:** API 26+ (Android 8.0).

## License

MIT
