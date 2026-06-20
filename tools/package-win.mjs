#!/usr/bin/env node
// Build a self-contained Windows distribution of the CC Remote server + launcher.
//
//   node tools/package-win.mjs
//
// Produces  dist/CC-Remote-Server/  containing:
//   CCRemoteLauncher.exe (+ .config)   the ~15 KB net4.8 launcher
//   server/{src,package.json,config.json,node_modules}
//
// The target machine needs Windows 10/11 (built-in .NET Framework 4.8) and Node.js
// on PATH (already true on any box with the `claude` CLI installed). Zip the folder
// and ship it — no installer required.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherDir = path.join(repoRoot, 'launcher');
const serverDir = path.join(repoRoot, 'server');
const distRoot = path.join(repoRoot, 'dist', 'CC-Remote-Server');

function run(cmd, cwd) {
  console.log(`\n> ${cmd}  (in ${path.relative(repoRoot, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// 1) Sync versions from the root VERSION file.
run('node tools/sync-version.mjs', repoRoot);

// 2) Build the launcher (net48 -> tiny exe).
run('dotnet build -c Release', launcherDir);

const outDir = path.join(launcherDir, 'bin', 'Release', 'net48');
const exe = path.join(outDir, 'CCRemoteLauncher.exe');
if (!fs.existsSync(exe)) {
  console.error(`[package] launcher build output not found: ${exe}`);
  process.exit(1);
}

// 3) Reset the dist folder.
fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });

// 4) Copy the launcher exe (+ .config if present).
fs.copyFileSync(exe, path.join(distRoot, 'CCRemoteLauncher.exe'));
const cfg = exe + '.config';
if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(distRoot, 'CCRemoteLauncher.exe.config'));

// 5) Stage the server (source + config only — never sessions/profiles/node_modules).
const stagedServer = path.join(distRoot, 'server');
fs.mkdirSync(stagedServer, { recursive: true });
fs.cpSync(path.join(serverDir, 'src'), path.join(stagedServer, 'src'), { recursive: true });
fs.copyFileSync(path.join(serverDir, 'package.json'), path.join(stagedServer, 'package.json'));
fs.copyFileSync(path.join(serverDir, 'config.json'), path.join(stagedServer, 'config.json'));
const lock = path.join(serverDir, 'package-lock.json');
if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(stagedServer, 'package-lock.json'));

// 6) Install production deps into the staged server (pure JS: ws + uuid).
run('npm install --omit=dev --no-audit --no-fund', stagedServer);

console.log(`\n[package] done -> ${path.relative(repoRoot, distRoot)}`);
console.log('[package] zip this folder and ship it. Double-click CCRemoteLauncher.exe to run.');
