#!/usr/bin/env node
// Generate platform icons from the root icon.png.
//
//   node tools/make-icons.mjs
//
// - launcher/app.ico   (multi-resolution ICO for Windows .NET)
// - android mipmaps    (ldpi → xxxhdpi PNGs for the app launcher icon)
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
// Buffered-ICO builder (PNG frames only — no BMP legacy frames).
// The ICO format is:  6-byte header + N×16-byte dir entries + image data.
// Every OS that ships together with .NET Framework 4.8 also reads
// PNG-compressed ICO frames (Vista+).
// ================================================================
async function writeIco(outPath, sizes) {
  const frames = [];
  for (const size of sizes) {
    const buf = await sharp(src).resize(size, size).png().toBuffer();
    frames.push({ w: size === 256 ? 0 : size, h: size === 256 ? 0 : size, buf });
  }

  // Header: reserved(2)=0, type(2)=1, count(2)
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(count, 4);

  // Directory entries (16 bytes each) + image data
  let offset = 6 + count * 16;
  const dirs = [];
  for (const f of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(f.w, 0);          // width  (0 = 256)
    entry.writeUInt8(f.h, 1);          // height (0 = 256)
    entry.writeUInt8(0, 2);            // palette
    entry.writeUInt8(0, 3);            // reserved
    entry.writeUInt16LE(1, 4);         // color planes
    entry.writeUInt16LE(32, 6);        // bpp
    entry.writeUInt32LE(f.buf.length, 8); // size
    entry.writeUInt32LE(offset, 12);   // offset
    offset += f.buf.length;
    dirs.push(entry);
  }

  const parts = [header, ...dirs, ...frames.map(f => f.buf)];
  fs.writeFileSync(outPath, Buffer.concat(parts));
  console.log(`[icons]   ${path.relative(repoRoot, outPath)} (${sizes.length} frames: ${sizes.join(',')})`);
}

// ================================================================
// Main
// ================================================================

// 1) Windows .ico  — sizes that cover all DPI levels + taskbar + window
const icoSizes = [16, 24, 32, 48, 64, 256];
const icoPath = path.join(repoRoot, 'launcher', 'app.ico');
await writeIco(icoPath, icoSizes);

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
