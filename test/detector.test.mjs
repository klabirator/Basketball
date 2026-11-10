import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShotDetector } from '../js/detector.js';
import { makeScene, scenario, renderFrame } from './synth.mjs';

function run(shots, opts = {}) {
  const scene = makeScene(opts.W ?? 400, opts.H ?? 225, opts);
  const det = new ShotDetector({ sensitivity: opts.sensitivity ?? 'medium' });
  const events = [];
  let rimAt = null;
  for (const { data, t } of scenario(scene, shots, opts)) {
    const res = det.process(data, scene.W, scene.H, t);
    for (const e of res.events) {
      if (e.type === 'rim-found' && rimAt == null) rimAt = t;
      events.push({ type: e.type, t });
    }
  }
  return { det, events, rimAt, scene, shotsOut: events.filter((e) => e.type === 'make' || e.type === 'miss').map((e) => e.type) };
}

test('кольцо находится автоматически за ~2 секунды', () => {
  const { det, rimAt, scene } = run([]);
  assert.ok(rimAt != null && rimAt < 2500, `rim found at ${rimAt}`);
  assert.ok(det.rimLocked);
  assert.ok(Math.abs(det.rim.cx - scene.rim.cx) < 3, `cx ${det.rim.cx} vs ${scene.rim.cx}`);
  assert.ok(Math.abs(det.rim.cy - scene.rim.cy) < 3, `cy ${det.rim.cy} vs ${scene.rim.cy}`);
  assert.ok(Math.abs(det.rim.w - scene.rim.w) / scene.rim.w < 0.2, `w ${det.rim.w} vs ${scene.rim.w}`);
});

test('попадания и промахи распознаются', () => {
  const shots = ['make', 'miss-left', 'make', 'miss-right', 'rim-out', 'make', 'short', 'make'];
  const expected = shots.map((k) => (k === 'make' ? 'make' : 'miss'));
  const { shotsOut } = run(shots);
  assert.deepEqual(shotsOut, expected);
});

test('работает на другом разрешении и с мелким кольцом', () => {
  const shots = ['make', 'miss-right', 'make', 'rim-out'];
  const { shotsOut } = run(shots, { W: 320, H: 180, rimFrac: 0.075 });
  assert.deepEqual(shotsOut, ['make', 'miss', 'make', 'miss']);
});

test('портретная ориентация кадра', () => {
  const shots = ['make', 'miss-left', 'make'];
  const { shotsOut } = run(shots, { W: 225, H: 400, rimFrac: 0.16 });
  assert.deepEqual(shotsOut, ['make', 'miss', 'make']);
});

test('без бросков нет ложных срабатываний (человек двигается в кадре)', () => {
  const { shotsOut } = run([], { tail: 10 });
  assert.deepEqual(shotsOut, []);
});

test('counting=false — броски не засчитываются, кольцо отслеживается', () => {
  const scene = makeScene(400, 225);
  const det = new ShotDetector();
  det.counting = false;
  let n = 0;
  for (const { data, t } of scenario(scene, ['make', 'make'])) {
    n += det.process(data, 400, 225, t).events.filter((e) => e.type === 'make' || e.type === 'miss').length;
  }
  assert.equal(n, 0);
  assert.ok(det.rimLocked);
});

test('устойчивость к шуму сенсора и скачку экспозиции', () => {
  const scene = makeScene(400, 225);
  const det = new ShotDetector();
  const shots = ['make', 'miss-left', 'make', 'rim-out', 'make'];
  const out = [];
  let s = 7;
  for (const { data, t } of scenario(scene, shots)) {
    const boost = t > 6000 ? 25 : 0;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        s = (s * 1103515245 + 12345) >>> 0;
        data[i + c] = Math.max(0, Math.min(255, data[i + c] + boost + ((s >>> 16) % 37) - 18));
      }
    }
    for (const e of det.process(data, 400, 225, t).events) if (e.type === 'make' || e.type === 'miss') out.push(e.type);
  }
  assert.deepEqual(out, ['make', 'miss', 'make', 'miss', 'make']);
});

// ── Конвейер как в приложении: цвет только предлагает, кольцо подтверждается формой (сетка + щит) ──
import { RimLocator } from '../js/rimfinder.js';

function runPipeline(shots, opts = {}) {
  const scene = makeScene(opts.W ?? 400, opts.H ?? 225, opts);
  const det = new ShotDetector({ colorAutoLock: false });
  const loc = new RimLocator();
  const out = [];
  let rimAt = null, frame = 0;
  for (const { data, t } of scenario(scene, shots, opts)) {
    const res = det.process(data, scene.W, scene.H, t);
    for (const e of res.events) {
      if (e.type === 'rim-found' && rimAt == null) rimAt = t;
      if (e.type === 'make' || e.type === 'miss') out.push(e.type);
    }
    if (frame++ % 18 === 0) {
      const g = new Uint8Array(scene.W * scene.H);
      for (let i = 0; i < g.length; i++) g[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
      det.offerRim(loc.locate(g, scene.W, scene.H, det._rimCand));
    }
  }
  return { det, scene, out, rimAt };
}

test('тёмное (не оранжевое) кольцо находится по сетке и щиту', () => {
  const { det, scene, rimAt, out } = runPipeline(['make', 'miss-left', 'make'], { rimColor: [45, 30, 28] });
  assert.ok(rimAt != null && rimAt < 2500, `rim at ${rimAt}`);
  assert.ok(Math.abs(det.rim.cx - scene.rim.cx) < scene.rim.w * 0.25, `cx ${det.rim.cx}`);
  assert.ok(Math.abs(det.rim.cy - scene.rim.cy) < scene.rim.w * 0.2, `cy ${det.rim.cy}`);
  assert.deepEqual(out, ['make', 'miss', 'make']);
});

test('оранжевая деревянная панель не принимается за кольцо', () => {
  const scene = makeScene(400, 225, { rimColor: [45, 30, 28], panel: true });
  const colorOnly = new ShotDetector(); // старое поведение: только цвет
  for (const { data, t } of scenario(scene, [], { tail: 1 })) colorOnly.process(data, 400, 225, t);
  assert.ok(colorOnly.rimLocked && colorOnly.rim.cx < 400 * 0.25, 'сцена воспроизводит ловушку для поиска по цвету');

  const { det, out } = runPipeline(['make', 'rim-out', 'make'], { rimColor: [45, 30, 28], panel: true });
  assert.ok(det.rimLocked && Math.abs(det.rim.cx - scene.rim.cx) < scene.rim.w * 0.25, `кольцо ${JSON.stringify(det.rim)}`);
  assert.deepEqual(out, ['make', 'miss', 'make']);
});

test('оранжевое кольцо — конвейер приложения', () => {
  const { out, rimAt } = runPipeline(['make', 'miss-right', 'make', 'short'], { W: 480, H: 270 });
  assert.ok(rimAt != null);
  assert.deepEqual(out, ['make', 'miss', 'make', 'miss']);
});

test('поиск по форме: разные размеры, ориентация, цвет обода', () => {
  const loc = new RimLocator();
  for (const [W, H, rf, col] of [[800, 450, 0.06, [45, 30, 28]], [800, 450, 0.1, [225, 70, 25]], [450, 800, 0.16, [45, 30, 28]], [640, 360, 0.045, [90, 90, 95]], [800, 450, 0.18, [45, 30, 28]]]) {
    const sc = makeScene(W, H, { rimFrac: rf, rimColor: col, panel: true });
    const d = renderFrame(sc, null, { x: W * 0.12 }, 0);
    const g = new Uint8Array(W * H);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    const r = loc.locate(g, W, H);
    assert.ok(r, `${W}x${H} rim ${sc.rim.w}: не найдено`);
    assert.ok(Math.hypot(r.cx - sc.rim.cx, r.cy - sc.rim.cy) < sc.rim.w * 0.4, `${W}x${H} rim ${sc.rim.w}: ${JSON.stringify(r)}`);
  }
});

// ── Групповая тренировка: несколько мячей в воздухе одновременно, подбор под кольцом, ведение ──
import { crowdScenario, evaluate } from './crowd.mjs';

function runCrowd(opts) {
  const scene = makeScene(400, 225);
  const sc = crowdScenario(scene, opts);
  const det = new ShotDetector({ colorAutoLock: false });
  const loc = new RimLocator();
  const events = [];
  let f = 0;
  for (const { data, t } of sc.frames()) {
    for (const e of det.process(data, 400, 225, t).events) events.push({ type: e.type, t });
    if (f++ % 18 === 0) {
      const g = new Uint8Array(400 * 225);
      for (let i = 0; i < g.length; i++) g[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
      det.offerRim(loc.locate(g, 400, 225, det._rimCand));
    }
  }
  return evaluate(sc.truth, events);
}

test('один игрок с высокими дугами (мяч уходит за верх кадра, отскоки от дужки)', () => {
  const r = runCrowd({ shooters: 1, gap: 3, walkers: 0, rebounders: false, seed: 29, duration: 30 });
  assert.equal(r.correct, r.total, JSON.stringify(r.details));
  assert.equal(r.extra, 0, JSON.stringify(r.details));
});

test('двое бросают по очереди и одновременно, рядом ходят люди', () => {
  const r = runCrowd({ shooters: 2, gap: 4, walkers: 2, rebounders: false, seed: 3, duration: 30 });
  assert.ok(r.correct / r.total >= 0.95, `верно ${r.correct}/${r.total}: ${JSON.stringify(r.details)}`);
  assert.equal(r.extra, 0, JSON.stringify(r.details));
});

test('четверо, игрок прыгает на подбор под кольцом, ведут мяч (~1 бросок/с)', () => {
  const r = runCrowd({ shooters: 4, gap: 4, walkers: 3, rebounders: true, dribblers: 1, seed: 11, duration: 30 });
  assert.ok(r.correct / r.total >= 0.8, `верно ${r.correct}/${r.total}: ${JSON.stringify(r.details)}`);
  assert.ok(r.extra <= 2, `лишних ${r.extra}: ${JSON.stringify(r.details)}`);
});

// ── Уроки реальных видео ──
test('ширина кольца, заниженная поиском, уточняется по размеру мяча', () => {
  const scene = makeScene(400, 225);
  const det = new ShotDetector({ colorAutoLock: false });
  // как на реальном уличном видео: положение верное, ширина занижена в 1.7 раза и не подтверждена щитом
  det.setRim({ cx: scene.rim.cx, cy: scene.rim.cy, w: scene.rim.w / 1.7, h: scene.rim.h }, { source: 'shape', sure: false });
  const out = [];
  let resized = null;
  for (const { data, t } of scenario(scene, ['miss-left', 'make', 'rim-out', 'make'])) {
    for (const e of det.process(data, 400, 225, t).events) {
      if (e.type === 'rim-resized') resized = e.w;
      if (e.type === 'make' || e.type === 'miss') out.push(e.type);
    }
  }
  assert.ok(resized && Math.abs(resized / scene.rim.w - 1) < 0.15, `ширина ${resized} вместо ${scene.rim.w}`);
  assert.deepEqual(out.slice(1), ['make', 'miss', 'make']); // первый бросок идёт на калибровку
});

test('ширина, подтверждённая щитом или заданная вручную, по мячу не меняется', () => {
  const scene = makeScene(400, 225);
  const det = new ShotDetector({ colorAutoLock: false });
  det.setRim(scene.rim, { manual: true });
  for (const { data, t } of scenario(scene, ['make', 'make'])) {
    assert.ok(!det.process(data, 400, 225, t).events.some((e) => e.type === 'rim-resized'));
  }
  assert.equal(det.rim.w, scene.rim.w);
});

test('движущаяся камера: броски не считаются, выдаётся предупреждение', () => {
  const scene = makeScene(400, 225);
  const det = new ShotDetector({ colorAutoLock: false });
  det.setRim(scene.rim, { source: 'shape' });
  const frame = new Uint8ClampedArray(400 * 225 * 4);
  let warned = false, shots = 0, f = 0;
  for (const { data, t } of scenario(scene, ['make', 'make', 'make'])) {
    // панорама: кадр каждые ~0.5 с резко сдвигается по горизонтали
    const shift = Math.floor(f++ / 15) * 37 % 200;
    for (let y = 0; y < 225; y++) for (let x = 0; x < 400; x++) {
      const s = (y * 400 + ((x + shift) % 400)) * 4, d = (y * 400 + x) * 4;
      // текстура как в реальном зале (плитка, разметка): без неё сдвиг однотонной стены не виден
      const tex = ((((x + shift) % 400) >> 3) + (y >> 3)) % 2 ? 22 : -22;
      frame[d] = data[s] + tex; frame[d + 1] = data[s + 1] + tex; frame[d + 2] = data[s + 2] + tex; frame[d + 3] = 255;
    }
    for (const e of det.process(frame, 400, 225, t).events) {
      if (e.type === 'camera-moving') warned = true;
      if (e.type === 'make' || e.type === 'miss') shots++;
    }
  }
  assert.ok(warned, 'нет предупреждения о движении камеры');
  assert.equal(shots, 0);
  assert.ok(!det.rimLocked, 'кольцо должно быть сброшено');
});
