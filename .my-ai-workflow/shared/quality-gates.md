# Quality Gates

## Build Commands

- Android release packaging: `node package-android.mjs`
- Windows launcher packaging: `node package-win.mjs`
- Version sync only: `node tools/sync-version.mjs`
- Server bundle only: `node tools/build-server-bundle.mjs`

## Server Commands

- Start server: run `npm start` from `server/`.
- Start server with watch mode: run `npm run dev` from `server/`.
- `server/package.json` does not define test, lint, format, or typecheck scripts.

## Android Commands

- Default project release path: `node package-android.mjs` from the repository root.
- Direct Gradle commands such as `.\gradlew.bat assembleDebug`, `.\gradlew.bat installDebug`, and `.\gradlew.bat test` are useful for focused Android debugging but are not the repository's release packaging path.

## Windows Launcher Commands

- Release packaging: `node package-win.mjs` from the repository root.
- Narrow launcher build/debugging: `dotnet build -c Release` from `launcher/`.

## Root Package Commands

- Root `package.json` has a placeholder `test` script that exits with an error. Do not treat it as a passing validation gate.

## Manual Verification

- For server protocol/session changes, verify relevant WebSocket message behavior or at least server startup and affected endpoint/session flow.
- For Android UI/client changes, build the Android artifact or run targeted Gradle debugging commands when appropriate.
- For launcher changes, build/package the launcher and confirm startup/server-control behavior when feasible.

## Missing Gates

- No repository-level lint command was found.
- No repository-level typecheck command was found.
- No CI workflow was found.
