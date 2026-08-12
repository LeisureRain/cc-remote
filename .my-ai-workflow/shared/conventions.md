# Conventions

## Code Style

- Server code uses CommonJS modules, `require`, classes where useful, and semicolons.
- Server WebSocket protocol handlers are organized around JSON `type` values.
- Server runtime files that may contain tokens or local user data live under ignored directories such as `server/profiles/`, `server/sessions/`, and agent-specific local data folders.
- Android code uses Java, package namespace `com.romp.ccremote`, XML layouts/resources, and POJO model classes for JSON shapes.
- Windows launcher code uses C# WinForms targeting `net48`.
- Packaging/tooling scripts use Node.js ES modules (`.mjs`) and keep repo-root commands easy to discover.

## Naming And Directory Patterns

- Server session adapters are named by agent: `claude-session.js`, `codex-session.js`, `opencode-session.js`.
- Android UI classes live under `android/app/src/main/java/com/romp/ccremote/ui/`.
- Android models live under `android/app/src/main/java/com/romp/ccremote/model/`.
- Shared packaging helpers live under `tools/`; root `package-*.mjs` files are the release entry points.
- Human-facing release version comes from root `VERSION`.

## Documentation Expectations

- `CLAUDE.md` should be kept current when architecture, WebSocket protocol, config keys, or components change.
- README files describe user-facing setup, features, and packaging commands.
- `agents.md` provides agent-specific build command instructions.

## Repository-Specific Rules

- Build Android release artifacts from the repository root with `node package-android.mjs`.
- Do not use `cd android && .\gradlew.bat assembleDebug` as the default Android build path.
- Direct Gradle commands are reserved for narrow debugging and should be identified as non-release packaging paths.
- Completed logical changes should be committed directly to `master` with Conventional Commit messages and a `Co-Authored-By` trailer, per `CLAUDE.md`. Pushing is only on explicit user request.

## Assumptions To Confirm

- Conventional Commit plus `Co-Authored-By` trailer applies to all agent-made commits in this repository.
- `.gitignore` entries for root `package.json`, `package-lock.json`, and `scripts/` are historical or accidental because those files/directories currently exist in the repository.
