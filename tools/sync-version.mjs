#!/usr/bin/env node
// Single-source-of-truth version sync.
// Reads the root VERSION file and propagates it to every component:
//   - server/package.json        -> "version"
//   - launcher/CCRemoteLauncher.csproj -> <Version>/<AssemblyVersion>/<FileVersion>
//   - android/app/build.gradle   -> versionName  (versionCode is left alone — it must
//                                   increase monotonically and is bumped manually)
//
// Usage:  node tools/sync-version.mjs
// Zero dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s, 'utf8');

const version = read(path.join(repoRoot, 'VERSION')).trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[sync-version] VERSION must be MAJOR.MINOR.PATCH, got: "${version}"`);
  process.exit(1);
}
const version4 = `${version}.0`; // .NET assembly/file versions want 4 parts

let changed = 0;
function applied(label, file, before, after) {
  if (before === after) { console.log(`[sync-version]   = ${label} (already ${version})`); return; }
  write(file, after);
  changed++;
  console.log(`[sync-version]   ✓ ${label} -> ${version}`);
}

// --- server/package.json ---
{
  const file = path.join(repoRoot, 'server', 'package.json');
  const before = read(file);
  const json = JSON.parse(before);
  json.version = version;
  // JSON.stringify drops trailing newline; preserve a trailing newline if the file had one.
  const after = JSON.stringify(json, null, 2) + (before.endsWith('\n') ? '\n' : '');
  applied('server/package.json', file, before, after);
}

// --- launcher/CCRemoteLauncher.csproj ---
{
  const file = path.join(repoRoot, 'launcher', 'CCRemoteLauncher.csproj');
  if (fs.existsSync(file)) {
    const before = read(file);
    const after = before
      .replace(/<Version>[^<]*<\/Version>/, `<Version>${version}</Version>`)
      .replace(/<AssemblyVersion>[^<]*<\/AssemblyVersion>/, `<AssemblyVersion>${version4}</AssemblyVersion>`)
      .replace(/<FileVersion>[^<]*<\/FileVersion>/, `<FileVersion>${version4}</FileVersion>`);
    applied('launcher/CCRemoteLauncher.csproj', file, before, after);
  } else {
    console.log('[sync-version]   - launcher/CCRemoteLauncher.csproj not found, skipping');
  }
}

// --- android/app/build.gradle (versionName only) ---
{
  const file = path.join(repoRoot, 'android', 'app', 'build.gradle');
  const before = read(file);
  const after = before.replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
  applied('android/app/build.gradle (versionName)', file, before, after);
}

console.log(`[sync-version] done — version ${version}, ${changed} file(s) updated.`);
