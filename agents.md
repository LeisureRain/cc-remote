# Agent Instructions

## Build Commands

- Build Android from the repository root with `node package-android.mjs`.
- Do not use `cd android && .\gradlew.bat assembleDebug` as the default Android build path.
- The root Android packaging script syncs the root `VERSION`, selects a JDK 17+ when available, runs the Gradle release build, and writes the signed APK to `dist/cc-remote-v<VERSION>.apk`.
- Use direct Gradle commands only for narrow debugging when explicitly needed, and mention that they are not the release packaging path.

