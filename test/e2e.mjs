// Сквозной тест: синтетическое видео подаётся в Chromium как камера, приложение должно само
// найти кольцо и посчитать броски. Запуск: npm run e2e  (нужен playwright с Chromium).
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeScene, scenario } from './synth.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = ['make', 'miss-left', 'make', 'rim-out', 'make', 'miss-right'];
const EXPECT = SHOTS.map((s) => (s === 'make' ? 1 : 0));
const W = 480, H = 270, FPS = 30, LEAD = 9, GAP = 2.6;

async function writeY4M(path, shots = SHOTS, lead = LEAD, sceneOpts = {}) {
  const scene = makeScene(W, H, sceneOpts);
  const out = createWriteStream(path);
  out.write(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const Y = Buffer.alloc(W * H), U = Buffer.alloc((W / 2) * (H / 2)), V = Buffer.alloc((W / 2) * (H / 2));
  for (const { data } of scenario(scene, shots, { fps: FPS, lead, gap: GAP, tail: 3 })) {
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      Y[i] = Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b));
    }
    for (let y = 0; y < H / 2; y++)
      for (let x = 0; x < W / 2; x++) {
        const i = (y * 2 * W + x * 2) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        U[y * (W / 2) + x] = Math.max(0, Math.min(255, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b));
        V[y * (W / 2) + x] = Math.max(0, Math.min(255, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b));
      }
    const ok = out.write(Buffer.concat([Buffer.from('FRAME\n'), Y, U, V]));
    if (!ok) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r) => out.end(r));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serve() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      try {
        const body = await readFile(join(root, p === '/' ? 'index.html' : p));
        res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'text/html' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const dir = await mkdtemp(join(process.env.E2E_TMP || tmpdir(), 'snaiper-'));
const video = join(dir, 'scene.y4m');
let browser, srv;
try {
  // камера: тёмное кольцо и оранжевая деревянная панель (как в реальном зале)
  await writeY4M(video, SHOTS, LEAD, { rimColor: [45, 30, 28], panel: true });
  srv = await serve();
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, permissions: ['camera'] });
  await ctx.addInitScript(() => localStorage.setItem('snaiper.settings.v1', JSON.stringify({ seenHelp: true, voiceMode: 'off', lastMode: 'free' })));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__snaiper.detector.rimLocked, null, { timeout: 8000 });
  const found = await page.evaluate(() => performance.now());
  console.log('кольцо найдено');
  await page.waitForTimeout((LEAD + 2 * GAP) * 1000 - 2000);
  await page.screenshot({ path: join(root, 'test', 'e2e-screen.png') });
  await page.waitForTimeout((SHOTS.length - 2) * GAP * 1000 + 1500);
  const shots = await page.evaluate(() => window.__snaiper.T.shots.map((s) => s.r));
  console.log('броски:', JSON.stringify(shots), 'ожидалось:', JSON.stringify(EXPECT));
  const hud = await page.evaluate(() => [document.querySelector('#s-makes').textContent, document.querySelector('#s-att').textContent, document.querySelector('#s-pct').textContent]);
  console.log('HUD:', hud.join(' '));
  await page.click('#b-stop');
  await page.click('#fin-yes');
  await page.waitForSelector('#screen-summary.active');
  await page.click('#screen-summary [data-go="history"]');
  await page.waitForSelector('.sess');
  await page.screenshot({ path: join(root, 'test', 'e2e-history.png') });
  if (JSON.stringify(shots) !== JSON.stringify(EXPECT)) throw new Error('Счёт не совпал');

  // ── Проверка на загруженном видео ──
  const VSHOTS = ['make', 'miss-right', 'make', 'rim-out'];
  const VEXPECT = ['Попадание', 'Промах', 'Попадание', 'Промах'];
  const y4m2 = join(dir, 'clip.y4m'), webm = join(dir, 'clip.webm');
  await writeY4M(y4m2, VSHOTS, 3);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', y4m2, '-c:v', 'libvpx', '-b:v', '3M', '-deadline', 'good', webm]);
  await page.click('#screen-history [data-go="home"]');
  await page.setInputFiles('#video-file', webm);
  for (const speed of ['1×', '2×']) {
    await page.waitForSelector('#screen-summary.active', { timeout: 40000 });
    const got = await page.$$eval('.events li span:last-child', (els) => els.map((e) => e.textContent));
    console.log(`видео ${speed}:`, JSON.stringify(got));
    if (speed === '1×') await page.screenshot({ path: join(root, 'test', 'e2e-video.png') });
    if (JSON.stringify(got) !== JSON.stringify(VEXPECT)) throw new Error(`Видео ${speed}: распознано не то`);
    if (speed === '1×') {
      await page.click('#sum-again');
      await page.waitForSelector('#screen-train.active');
      await page.click('#v-speed'); // 1× → 2×
    }
  }
  if (errors.length) throw new Error('Ошибки на странице: ' + errors.join('; '));
  void found;
  console.log('E2E OK');
} finally {
  await browser?.close();
  srv?.close();
  await rm(dir, { recursive: true, force: true });
}
