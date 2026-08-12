# Decisions

- The server uses WebSocket JSON messages with a `type` field as the client/server protocol.
- Session state is owned by the server and persisted under `sessionsDir` when enabled.
- Provider switching uses CC Remote's private `server/profiles/active-settings.json` overlay and launches Claude with `--settings`; it does not overwrite `~/.claude/settings.json`.
- CC Switch integration is read-only against `~/.cc-switch/cc-switch.db`.
- Root `VERSION` is the single source of truth for user-facing version strings; `versionCode` remains manually bumped.
- Android release packaging should run through root `node package-android.mjs`.
- Windows launcher distribution embeds a staged server bundle and extracts it under `%LOCALAPPDATA%\CC-Remote\server`, preserving user config.

## No Decision Recorded

- No CI or automated release publishing decision was found.
