#!/usr/bin/env node
// Build the single-file Windows distribution of CC Remote.
//
//   node package-win.mjs
//
// Produces  dist/CCRemoteLauncher-v<VERSION>.exe  — ONE self-contained file. The entire
// server (src + production node_modules + default config.json) is embedded inside the exe
// and extracted to %LOCALAPPDATA%\CC-Remote\server on first run.
//
// The target machine still needs Node.js + the `claude` CLI on PATH — the exe drives the
// local claude CLI, it does not replace it. (Any box with `claude` installed already has Node.)

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const launcherDir = path.join(repoRoot, 'launcher');
const distRoot = path.join(repoRoot, 'dist');

function run(cmd, cwd) {
  console.log(`\n> ${cmd}  (in ${path.relative(repoRoot, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

const version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();

// 1) Sync versions from the root VERSION file.
run('node tools/sync-version.mjs', repoRoot);

// 2) Embed the whole server into a zip resource.
run('node tools/build-server-bundle.mjs', repoRoot);

// 3) Build the launcher (picks up server-bundle.zip as an embedded resource).
//    Force a rebuild so the freshly built bundle is embedded.
run('dotnet build -c Release -t:Rebuild', launcherDir);

const outDir = path.join(launcherDir, 'bin', 'Release', 'net48');
const exe = path.join(outDir, 'CCRemoteLauncher.exe');
if (!fs.existsSync(exe)) {
  console.error(`[package] launcher build output not found: ${exe}`);
  process.exit(1);
}

// 4) Emit the launcher (+ its .config) to dist/ with a versioned name.
//    Only clean old Windows artifacts so Android APKs in dist/ are untouched.
fs.mkdirSync(distRoot, { recursive: true });
for (const f of fs.readdirSync(distRoot)) {
  if (f.startsWith('CCRemoteLauncher')) fs.rmSync(path.join(distRoot, f));
}
const outExe = path.join(distRoot, `CCRemoteLauncher-v${version}.exe`);
fs.copyFileSync(exe, outExe);
const cfg = exe + '.config';
if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(distRoot, `CCRemoteLauncher-v${version}.exe.config`));

const kb = Math.round(fs.statSync(outExe).size / 1024);
console.log(`\n[package] done -> dist/CCRemoteLauncher-v${version}.exe (${kb} KB, server embedded)`);
console.log('[package] ship this single exe. Target needs Node.js + claude CLI on PATH.');
