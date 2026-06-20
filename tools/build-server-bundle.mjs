#!/usr/bin/env node
// Build launcher/server-bundle.zip — the entire server embedded into the launcher exe.
//
//   node tools/build-server-bundle.mjs
//
// Stages the server (src + package.json + default config.json), installs production-only
// deps (ws + uuid, pure JS), and zips it via PowerShell Compress-Archive (no npm deps).
// The launcher embeds this zip and extracts it to %LOCALAPPDATA%\CC-Remote\server on first run.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(repoRoot, 'server');
const launcherDir = path.join(repoRoot, 'launcher');
const stage = path.join(launcherDir, '.bundle-stage');
const zipOut = path.join(launcherDir, 'server-bundle.zip');

function run(cmd, cwd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// 1) Fresh staging dir with server source + config (never sessions/profiles).
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(serverDir, 'src'), path.join(stage, 'src'), { recursive: true });
fs.copyFileSync(path.join(serverDir, 'package.json'), path.join(stage, 'package.json'));
fs.copyFileSync(path.join(serverDir, 'config.json'), path.join(stage, 'config.json'));
const lock = path.join(serverDir, 'package-lock.json');
if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(stage, 'package-lock.json'));

// 2) Production deps (ws + uuid).
run('npm install --omit=dev --no-audit --no-fund', stage);

// 3) Zip the staged contents (entries relative to the stage root).
fs.rmSync(zipOut, { force: true });
const ps = `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipOut}' -Force`;
run(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, repoRoot);

// 4) Cleanup staging.
fs.rmSync(stage, { recursive: true, force: true });

const kb = Math.round(fs.statSync(zipOut).size / 1024);
console.log(`\n[bundle] wrote ${path.relative(repoRoot, zipOut)} (${kb} KB)`);
