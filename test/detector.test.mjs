import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShotDetector } from '../js/detector.js';
import { makeScene, scenario } from './synth.mjs';

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
