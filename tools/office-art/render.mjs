// Photographs the three.js models in models.js into the PNGs the studio office loads, and writes
// worker/studio/office/art/manifest.json. On Windows it renders on the discrete GPU through
// headless Chromium (same flags as the Barcadia tools); elsewhere Chromium's own WebGL is fine.
//
//   npm install && npx playwright install chromium   (once)
//   node render.mjs                                    (all)   node render.mjs scout desk  (some)
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.resolve(here, '../../worker/studio/office/art');

// Largest size each sprite is saved at: 2.5-3x the box the page draws it in (office.js PROP_BOX).
const ROBOT = [192, 240];
const ASSETS = {
  scout: ROBOT, writer: ROBOT, narrator: ROBOT, editor: ROBOT, checker: ROBOT, publisher: ROBOT, analyst: ROBOT,
  desk: [290, 140], coffee: [400, 260], cooler: [110, 280], rack: [160, 320], sofa: [490, 190], plant: [140, 210], inbox: [140, 205],
};
const ROBOTS = new Set(['scout', 'writer', 'narrator', 'editor', 'checker', 'publisher', 'analyst']);

const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force-high-performance-gpu'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const server = createServer(async (req, res) => {
  const file = path.join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(here)) return res.writeHead(403).end();
  const body = await readFile(file).catch(() => null);
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ASSETS);
for (const n of names) if (!ASSETS[n]) { console.error(`Unknown asset ${n}. Known: ${Object.keys(ASSETS).join(', ')}`); process.exit(1); }

const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? GPU_ARGS : [], executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/render.html`);
await page.waitForFunction(() => window.ready === true);
console.log(`Rendering on: ${await page.evaluate(() => window.rendererName())}`);

await mkdir(ART, { recursive: true });
const manifestPath = path.join(ART, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{"robots":{},"props":{}}'));
for (const name of names) {
  const [w, h] = ASSETS[name];
  const url = await page.evaluate(([n, a, b]) => window.renderAsset(n, a, b), [name, w, h]);
  const file = ROBOTS.has(name) ? `robot-${name}.png` : `${name}.png`;
  await writeFile(path.join(ART, file), Buffer.from(url.split(',')[1], 'base64'));
  (ROBOTS.has(name) ? manifest.robots : manifest.props)[name] = file;
  console.log(`${name} -> worker/studio/office/art/${file}`);
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await browser.close();
server.close();
