# Repository Index

`.my-ai-workflow/`
  Project memory, branch progress, developer-local context, and handoff notes.

`README.md`, `README_CN.md`
  User-facing documentation, screenshots, setup, network access, configuration, and packaging instructions.

`CLAUDE.md`
  Detailed architecture, WebSocket protocol, commands, development workflow, and dependency guidance.

`agents.md`
  Agent-specific build instruction: Android release builds should use `node package-android.mjs` from repo root.

`VERSION`
  Human-facing version source synchronized into server, Android, and launcher files.

`package-android.mjs`
  Root Android release packaging entry point; syncs version, uses JDK 17+ when available, runs Gradle release build, emits signed APK to `dist/`.

`package-win.mjs`
  Root Windows launcher packaging entry point; syncs version, builds embedded server bundle, rebuilds launcher, emits versioned exe/config to `dist/`.

`tools/`
  Build helpers for version synchronization, icon generation, and server bundle creation.

`server/`
  Node.js server package, default config, and WebSocket/agent session runtime.

`server/src/index.js`
  Server entry point: HTTP, WebSocket, auth, config, profile management, message routing.

`server/src/session-manager.js`
  Session lifecycle, listing, stop/resume/delete/restart, persistence.

`server/src/*-session.js`
  Agent adapters for Claude, Codex, and OpenCode.

`server/src/agent-registry.js`
  Agent definitions and shared factory/model helpers.

`server/src/cc-switch.js`
  Read-only CC Switch profile discovery adapter.

`android/`
  Android Gradle project for the Java client.

`android/app/src/main/java/com/romp/ccremote/`
  Android application source: app initialization, WebSocket, UI, service, utilities, and models.

`android/app/src/main/res/`
  Android XML layouts, drawables, menus, values, launcher icons, and network security config.

`launcher/`
  C# WinForms Windows launcher project.

`launcher/MainForm.cs`
  Main launcher UI, server process control, log view, and `/health` polling.

`launcher/ServerLocator.cs`
  Embedded server extraction and launcher config read/write helpers.

`docs/`
  Design/planning docs. Currently includes a Chinese multi-agent CLI support plan.

`screenshots/`
  README image assets for Android and Windows launcher screens.

`dist/`
  Generated release artifacts; ignored build output.

`gradle-local/`, `gradle-bin.zip`
  Local Gradle distribution/cache artifacts; not server runtime code.
