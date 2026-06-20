# CC Remote Server Launcher (Windows)

A tiny Windows desktop app for starting / stopping the CC Remote server on an
ordinary user's machine with one click, and watching the server log live — no
command line required.

- **Single-file distribution**: the entire server (source + production dependencies +
  default config) is **embedded inside the exe** (~160 KB). Users download just this one
  file. The target .NET Framework 4.8 ships with Windows 10/11, so no runtime install is needed.
- **Main window**: Start / Stop / Restart the server, **Settings**, Clear Log, Open Server Folder,
  plus a live log box and a running-status line.
- **Single responsibility**: it only starts/stops the *server process*. Session-level actions
  (create / stop / restart / delete sessions) live in the Android app.

## Prerequisites (target machine)

- Windows 10 (1903+) or Windows 11 (ships with .NET Framework 4.8).
- **Node.js** installed with `node` on PATH (machines that have the `claude` CLI usually already qualify).
- The **`claude` CLI** installed and logged in (the server drives the local `claude` — the exe does not replace it).

## Running

Just double-click `CCRemoteLauncher-v<VERSION>.exe` (the version is in the file name) — that one file is all
you need. On first run it extracts the embedded server into your user-data directory, launches it with the
system `node`, and streams the log into the window. Closing the window also terminates the child processes
(node + claude).

- Server is extracted to: `%LOCALAPPDATA%\CC-Remote\server\` (writable, no admin rights needed).
- `config.json` (port, etc.), `sessions/`, and `profiles/` persist in that directory; **upgrading to a new exe
  only refreshes code and never overwrites your edited `config.json`**.
- To change the **port** or **workspace directory**: click **Settings** in the UI — saving auto-restarts the
  server to apply (you can also edit `config.json` in that directory by hand).

> If the exe has no embedded server (a plain `dotnet build` dev build), it falls back to a sibling/ancestor
> `server/` directory.

## Building from source

Requires the .NET SDK (8.0.x works locally; it compiles net48 offline):

```bash
cd launcher
dotnet build -c Release
# Output: bin/Release/net48/CCRemoteLauncher.exe (no embedded server; for dev/debug)
```

The build uses `Microsoft.NETFramework.ReferenceAssemblies` at compile time only (already in the NuGet cache);
the final exe contains no extra DLLs.

## Packaging (the distributable single exe)

From the repo root:

```bash
node package-win.mjs
# 1) sync version  2) bundle the server into server-bundle.zip as an embedded resource
# 3) rebuild  ->  dist/CCRemoteLauncher-v<VERSION>.exe (version from the root VERSION file)
```

Ship `dist/CCRemoteLauncher-v<VERSION>.exe` directly to users.

## Versioning

The version is managed by the repo-root `VERSION` file. After editing it, run `node tools/sync-version.mjs`
to propagate the version to this launcher's `.csproj`, `server/package.json`, and Android's `versionName`.
