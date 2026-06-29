// capture.mjs — render the avatar viewer headlessly and save one PNG per animation frame.
//
//   node capture.mjs                 # all signs from anim/index.json
//   node capture.mjs COFFEE WATER    # just these
//   node capture.mjs --probe COFFEE  # only frames 0 and middle (fast calibration check)
//
// Serves this directory over http, drives window.AvatarAPI frame-by-frame in headless Chromium
// (WebGL via SwiftShader), and writes frames/<SIGN>/f####.png. core/encode (Python+cv2) turns those
// into reference_clips/<SIGN>.mp4.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5188;
const SIZE = 760;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.wasm': 'application/wasm' };

function serve() {
  return http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let fp = path.join(ROOT, url === '/' ? '/viewer.html' : url);
    if (!fp.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404).end('not found: ' + url); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(PORT);
}

async function main() {
  const args = process.argv.slice(2);
  const probe = args.includes('--probe');
  let names = args.filter((a) => !a.startsWith('--'));
  if (!names.length) names = JSON.parse(fs.readFileSync(path.join(ROOT, 'anim/index.json'))).signs;

  const server = serve();
  const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                      '--ignore-gpu-blocklist', '--disable-gpu-sandbox'];
  // Playwright's bundled Chromium failed to download here; drive the system Edge/Chrome instead.
  let browser = null;
  for (const channel of ['msedge', 'chrome', null]) {
    try {
      browser = await chromium.launch({ headless: true, args: launchArgs,
        ...(channel ? { channel } : {}) });
      console.log('launched browser via', channel || 'bundled chromium');
      break;
    } catch (e) { console.log(`  (${channel || 'bundled'} unavailable: ${e.message.split('\n')[0]})`); }
  }
  if (!browser) throw new Error('no usable browser (Edge/Chrome/bundled all failed)');
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [page error]', m.text());
    else if (m.text().startsWith('setHand')) console.log('  [dbg]', m.text());
  });
  await page.goto(`http://localhost:${PORT}/viewer.html`);
  await page.waitForFunction(() => window.AvatarAPI && window.AvatarAPI.ready, null, { timeout: 30000 });

  if (args.includes('--handcal')) {
    const dir = path.join(ROOT, 'frames', 'handcal');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    for (const sg of [1, -1]) {
      for (const g of [2.0, 2.7, 3.4]) {
        const url = await page.evaluate(([s, gg]) => window.AvatarAPI.handCal(s, gg), [sg, g]);
        fs.writeFileSync(path.join(dir, `h_s${sg > 0 ? 'p' : 'n'}_g${g}.png`),
          Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
      }
    }
    console.log('  wrote 6 hand close-ups -> frames/handcal');
    await browser.close(); server.close(); return;
  }

  if (args.includes('--shapes')) {
    const dir = path.join(ROOT, 'frames', 'shapes');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const shapes = {
      A_fist: { ext: [0, 0, 0, 0], thumb: true }, B_flat: { ext: [1, 1, 1, 1], thumb: true },
      YOU_point: { ext: [1, 0, 0, 0], thumb: false }, L: { ext: [1, 0, 0, 0], thumb: true },
      V: { ext: [1, 1, 0, 0], thumb: false, spread: [0.30, -0.12, 0, 0] }, Y: { ext: [0, 0, 0, 1], thumb: true },
    };
    for (const [name, shape] of Object.entries(shapes)) {
      const url = await page.evaluate((sh) => window.AvatarAPI.handCal(1, 2.6, sh), shape);
      fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
    }
    console.log('  wrote handshape previews -> frames/shapes');
    await browser.close(); server.close(); return;
  }

  if (args.includes('--cal')) {
    const dir = path.join(ROOT, 'frames', 'cal');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    for (const ax of ['x', 'y', 'z']) {
      for (const sg of [1, -1]) {
        const url = await page.evaluate(([a, s]) => window.AvatarAPI.calibrate(a, s, 1.7), [ax, sg]);
        fs.writeFileSync(path.join(dir, `cal_${ax}_${sg > 0 ? 'p' : 'n'}.png`),
          Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
      }
    }
    console.log('  wrote 6 calibration frames -> frames/cal');
    await browser.close(); server.close(); return;
  }

  for (const name of names) {
    const count = await page.evaluate((n) => window.AvatarAPI.prepare(n), name);
    const outDir = path.join(ROOT, 'frames', name);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const idxs = probe ? [0, Math.floor(count / 2)] : [...Array(count).keys()];
    for (const i of idxs) {
      const dataUrl = await page.evaluate((k) => { window.AvatarAPI.showFrame(k); return window.AvatarAPI.snapshot(); }, i);
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(b64, 'base64'));
    }
    if (args.includes('--side')) {   // both sides to catch arm-through-body clipping
      for (const deg of [-65, 65]) {
        const url = await page.evaluate(([k, d]) => window.AvatarAPI.orbitSnapshot(k, d), [idxs[0], deg]);
        fs.writeFileSync(path.join(outDir, `side_${deg < 0 ? 'L' : 'R'}.png`), Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
      }
    }
    console.log(`  ${name}: wrote ${idxs.length} frame(s) -> frames/${name}`);
  }

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
