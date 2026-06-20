#!/usr/bin/env node
// Generate platform icons from the root icon.png.
//
//   node tools/make-icons.mjs
//
// - launcher/app.ico   (multi-resolution ICO for Windows .NET)
// - android mipmaps    (mdpi → xxxhdpi PNGs for the app launcher icon)
//
// Requires sharp (in root node_modules).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(repoRoot, 'icon.png');

if (!fs.existsSync(src)) {
  console.error('[icons] icon.png not found at repo root.');
  process.exit(1);
}

// ================================================================
// ICO helpers — produce both PNG and BMP ICOs.
//
//   - PNG ICO: compact, used as a .NET EmbeddedResource for the window
//     icon (MainForm.TryLoadIcon loads it via GetManifestResourceStream).
//   - BMP ICO: classic uncompressed frames; required by Roslyn's
//     /win32icon switch for the PE native icon (Explorer, taskbar).
//     Roslyn does NOT reliably embed PNG-in-ICO frames into .rsrc.
// ================================================================

function icoPack(frames) {
  const count = frames.length;
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE(0, 0);   // reserved
  hdr.writeUInt16LE(1, 2);   // type = ICO
  hdr.writeUInt16LE(count, 4);
  let off = 6 + count * 16;
  const dirs = frames.map(f => {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.w, 0);
    e.writeUInt8(f.h, 1);
    e.writeUInt8(0, 2);                // palette colours
    e.writeUInt8(0, 3);                // reserved
    e.writeUInt16LE(1, 4);             // color planes
    e.writeUInt16LE(32, 6);            // bpp
    e.writeUInt32LE(f.buf.length, 8);   // size
    e.writeUInt32LE(off, 12);          // offset
    off += f.buf.length;
    return e;
  });
  return Buffer.concat([hdr, ...dirs, ...frames.map(f => f.buf)]);
}

function icoDim(size) { return size === 256 ? 0 : size; }

// BMP DIB frame for Win32 PE icon resource.
// ICO convention: BITMAPINFOHEADER.biHeight is doubled.
function icoBmpFrame(rgba, w, h) {
  const rb = w * 4;
  const px = Buffer.alloc(rb * h);
  for (let y = 0; y < h; y++) {
    const sr = y * rb, dr = (h - 1 - y) * rb;
    for (let x = 0; x < w; x++) {
      const si = sr + x * 4, di = dr + x * 4;
      px[di] = rgba[si + 2]; px[di + 1] = rgba[si + 1];
      px[di + 2] = rgba[si]; px[di + 3] = rgba[si + 3];
    }
  }
  const bi = Buffer.alloc(40);
  bi.writeUInt32LE(40, 0); bi.writeInt32LE(w, 4); bi.writeInt32LE(h * 2, 8);
  bi.writeUInt16LE(1, 12); bi.writeUInt16LE(32, 14);
  bi.writeUInt32LE(px.length, 20);
  return Buffer.concat([bi, px]);
}

async function makeBmpFrames(sizes) {
  const frames = [];
  for (const s of sizes) {
    const { data, info } = await sharp(src).resize(s, s).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const buf = icoBmpFrame(data, info.width, info.height);
    frames.push({ w: icoDim(s), h: icoDim(s), buf });
  }
  return frames;
}

async function makePngFrames(sizes) {
  const frames = [];
  for (const s of sizes) {
    const buf = await sharp(src).resize(s, s).png().toBuffer();
    frames.push({ w: icoDim(s), h: icoDim(s), buf });
  }
  return frames;
}

// ================================================================
// Main
// ================================================================

// 1) Windows icons — two ICO files with different purposes:
//    - app.ico (PNG frames):  embedded managed resource for the window icon
//    - app-win32.ico (BMP frames):  /win32icon for the PE native icon (Explorer)
const launcherDir = path.join(repoRoot, 'launcher');
const icoAll = [16, 24, 32, 48, 64, 256];
const pngIco = icoPack(await makePngFrames(icoAll));
fs.writeFileSync(path.join(launcherDir, 'app.ico'), pngIco);
const kB = (pngIco.length / 1024).toFixed(1);
console.log(`[icons]   launcher/app.ico (${icoAll.length} frames PNG: ${icoAll.join(',')} — ${kB} KB)`);

const icoWin32 = [16, 32, 48];
const bmpIco = icoPack(await makeBmpFrames(icoWin32));
fs.writeFileSync(path.join(launcherDir, 'app-win32.ico'), bmpIco);
const kB2 = (bmpIco.length / 1024).toFixed(1);
console.log(`[icons]   launcher/app-win32.ico (${icoWin32.length} frames BMP: ${icoWin32.join(',')} — ${kB2} KB)`);

// 2) Android mipmap PNGs — adaptive-icon compatible densities
const densities = [
  { name: 'mipmap-mdpi',    size: 48 },
  { name: 'mipmap-hdpi',    size: 72 },
  { name: 'mipmap-xhdpi',   size: 96 },
  { name: 'mipmap-xxhdpi',  size: 144 },
  { name: 'mipmap-xxxhdpi', size: 192 },
];

const resDir = path.join(repoRoot, 'android', 'app', 'src', 'main', 'res');
for (const d of densities) {
  const dir = path.join(resDir, d.name);
  fs.mkdirSync(dir, { recursive: true });
  await sharp(src).resize(d.size, d.size).png().toFile(path.join(dir, 'ic_launcher.png'));
  console.log(`[icons]   ${d.name}/ic_launcher.png (${d.size}×${d.size})`);
}

// Also create the adaptive-icon foreground at 108dp (~324px at xxxhdpi):
// we resize the source to 324×324 then trim to the safe zone (inner 66dp = 198px).
// This gives the launcher a clean foreground that doesn't bleed into the
// OEM's custom mask shape (circle, squircle, teardrop, etc.).
const fgSize = 324;
const innerSize = Math.round(fgSize * 66 / 108); // safe zone: 198px
const pad = Math.round((fgSize - innerSize) / 2);
const fgBuf = await sharp(src)
  .resize(fgSize, fgSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
const foreDir = path.join(resDir, 'drawable');
fs.mkdirSync(foreDir, { recursive: true });
// Remove old vector foreground (replaced by the PNG)
const oldFg = path.join(foreDir, 'ic_launcher_foreground.xml');
if (fs.existsSync(oldFg)) {
  fs.rmSync(oldFg);
  console.log(`[icons]   removed old vector drawable/ic_launcher_foreground.xml`);
}
fs.writeFileSync(path.join(foreDir, 'ic_launcher_foreground.png'), fgBuf);
console.log(`[icons]   drawable/ic_launcher_foreground.png (adaptive safe-zone)`);

// Update the adaptive-icon XML to reference the PNG foreground
const bgColor = '#0D1117'; // dark theme base
const icLauncherXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;
fs.writeFileSync(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), icLauncherXml);
console.log(`[icons]   mipmap-anydpi-v26/ic_launcher.xml (adaptive, foreground PNG)`);

// Update the background color to match the icon's dark theme
const bgXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${bgColor}</color>
</resources>
`;
fs.writeFileSync(path.join(resDir, 'values', 'ic_launcher_background.xml'), bgXml);
console.log(`[icons]   values/ic_launcher_background.xml -> ${bgColor}`);

console.log(`\n[icons] done.`);
