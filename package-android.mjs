#!/usr/bin/env node
// Build the release APK of the CC Remote Android client.
//
//   node package-android.mjs
//
// Produces  dist/cc-remote-v<VERSION>.apk  — the signed release APK, ready to install.
// Signing uses the keystore committed at android/ccremote.keystore (config in
// android/app/build.gradle). The target device just needs to allow installing the APK.
//
// Requirements on the build machine: a JDK + the Android SDK (android/local.properties
// must point sdk.dir at it). The Gradle wrapper (gradle 8.4) is downloaded/cached on
// first run.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const androidDir = path.join(repoRoot, 'android');
const distRoot = path.join(repoRoot, 'dist');

function run(cmd, cwd) {
  console.log(`\n> ${cmd}  (in ${path.relative(repoRoot, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

const version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();

// 1) Sync versionName from the root VERSION file (versionCode is bumped manually).
run('node tools/sync-version.mjs', repoRoot);

// 2) Build the signed release APK. Use the platform's gradle wrapper.
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
run(`${gradlew} assembleRelease`, androidDir);

const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(apk)) {
  console.error(`[package] release APK not found: ${apk}`);
  process.exit(1);
}

// 3) Emit a versioned copy to dist/.
fs.mkdirSync(distRoot, { recursive: true });
const out = path.join(distRoot, `cc-remote-v${version}.apk`);
fs.copyFileSync(apk, out);

const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(2);
console.log(`\n[package] done -> dist/cc-remote-v${version}.apk (${mb} MB, signed release)`);
