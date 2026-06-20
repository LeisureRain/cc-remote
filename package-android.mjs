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

function findJdk17() {
  // Prefer JAVA_HOME_17 override, then check if current JAVA_HOME is 17+,
  // then scan common install paths.
  if (process.env.JAVA_HOME_17) return process.env.JAVA_HOME_17;
  if (process.env.JAVA_HOME) {
    const v = /jdk[-.]?(\d+)/i.exec(process.env.JAVA_HOME);
    if (v && parseInt(v[1], 10) >= 17) return process.env.JAVA_HOME;
  }
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\Java', 'C:\\Program Files (x86)\\Java']) {
      try {
        const dirs = fs.readdirSync(base, { withFileTypes: true });
        const jdk = dirs
          .filter(d => d.isDirectory() && /jdk[-.]?(1[7-9]|2\d)/i.test(d.name))
          .sort()
          .pop();
        if (jdk) return path.join(base, jdk.name);
      } catch {}
    }
  }
  return null;
}

function run(cmd, cwd, opts) {
  console.log(`\n> ${cmd}  (in ${path.relative(repoRoot, cwd) || '.'})`);
  const env = { ...process.env };
  // Gradle needs to download its distribution over HTTPS; JDK 8's truststore
  // is often too old. Auto-detect a JDK 17+ if available.
  const jdk17 = findJdk17();
  if (jdk17) env.JAVA_HOME = jdk17;
  execSync(cmd, { cwd, stdio: 'inherit', env, ...opts });
}

const version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();

// 1) Sync versionName from the root VERSION file (versionCode is bumped manually).
run('node tools/sync-version.mjs', repoRoot);

// 2) Build the signed release APK.
//    Use the shell script on Unix (git-bash, etc.); on native Windows cmd,
//    the full path to gradlew.bat + shell:true is needed so cmd finds it.
const gradlew = process.platform === 'win32'
  ? path.join(androidDir, 'gradlew.bat')
  : './gradlew';
run(`"${gradlew}" assembleRelease`, androidDir, { shell: true });

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
