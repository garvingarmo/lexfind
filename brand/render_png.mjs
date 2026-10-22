// Renders the PNG versions of the logo (app icons, favicon fallback, email header) from the SVGs in
// public/brand. Run after make_logo.py:  node brand/render_png.mjs   (needs Playwright + Chromium).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSvg = (f) => fs.readFileSync(path.join(ROOT, 'public', 'brand', f), 'utf8');
const out = (f) => path.join(ROOT, 'public', f);

// [output, canvas size (w,h), background, svg, size of the artwork inside, corner radius]
const JOBS = [
  ['icons/icon-192.png', [192, 192], null, 'chaldeanlaw-app-icon.svg', 1, 0.22],
  ['icons/icon-512.png', [512, 512], null, 'chaldeanlaw-app-icon.svg', 1, 0.22],
  // Maskable icons get cropped to a circle or squircle: the scales sit inside the central safe zone.
  ['icons/maskable-512.png', [512, 512], null, 'chaldeanlaw-app-icon-maskable.svg', 1, 0],
  // iOS rounds the corners itself.
  ['icons/apple-touch-icon.png', [180, 180], null, 'chaldeanlaw-app-icon.svg', 1, 0],
  ['icons/favicon-32.png', [32, 32], null, 'chaldeanlaw-favicon.svg', 1, 0],
  // Email header: the reverse logo on transparent, at 2x for sharp screens (shown 48px tall).
  ['brand/email-logo.png', [null, 96], null, 'chaldeanlaw-logo-horizontal-reverse-transparent.svg', 1, 0],
];

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
for (const [file, [w0, h], bg, svg, scale, radius] of JOBS) {
  const source = readSvg(svg);
  const [, , vw, vh] = source.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const ratio = vw / vh;
  const src = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
  const w = w0 ?? Math.round(h * ratio);
  const iw = w * scale; const ih = (w0 ? h : h) * scale;
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="width:${w}px;height:${h}px;display:grid;place-items:center;${bg ? `background:${bg};` : ''}border-radius:${radius * w}px;overflow:hidden">
      <img src="${src}" style="width:${w0 ? iw : w}px;height:${w0 ? ih : h}px;object-fit:contain"></div></body></html>`);
  await page.waitForFunction(() => document.querySelector('img').complete);
  await page.locator('div').screenshot({ path: out(file), omitBackground: true });
  console.log('wrote', file, `${w}x${h}`);
}
await browser.close();

// Copies at the site root, which some browsers and iOS request without reading the page.
for (const f of ['apple-touch-icon.png', 'apple-touch-icon-precomposed.png']) fs.copyFileSync(out('icons/apple-touch-icon.png'), out(f));
// favicon.ico: an ICO file holding the 32px PNG.
const png = fs.readFileSync(out('icons/favicon-32.png'));
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); // type icon, 1 image
ico.writeUInt8(32, 6); ico.writeUInt8(32, 7); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(out('favicon.ico'), Buffer.concat([ico, png]));
console.log('wrote apple-touch-icon.png, apple-touch-icon-precomposed.png, favicon.ico');
