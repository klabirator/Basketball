// Синтетическая баскетбольная сцена для тестов детектора и e2e (фейковая камера Chromium).
// Рисует стену, щит, оранжевое кольцо, сетку, «человека» и мяч, летящий по баллистической траектории.

export function makeScene(W, H, opts = {}) {
  const rimW = Math.round(W * (opts.rimFrac ?? 0.1));
  const rim = { cx: Math.round(W * 0.62), cy: Math.round(H * 0.38), w: rimW, h: Math.max(3, Math.round(rimW * 0.22)) };
  const ballR = rimW * 0.26;
  const g = H * 2.2; // px/s²
  return { W, H, rim, ballR, g, seed: opts.seed ?? 1 };
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Траектория броска. kind: 'make' | 'miss-left' | 'miss-right' | 'rim-out' | 'short'
 * Возвращает функцию pos(tSec) → {x, y} | null (мяч вне игры).
 */
export function shotPath(scene, kind, fromLeft = true) {
  const { rim, g, H, W, ballR } = scene;
  const x0 = fromLeft ? W * 0.12 : W * 0.95;
  const y0 = H * 0.82;
  const apexY = rim.cy - rim.w * 2.4;
  let xc = rim.cx;
  if (kind === 'miss-left') xc = rim.cx - rim.w * 1.3;
  if (kind === 'miss-right') xc = rim.cx + rim.w * 1.3;
  if (kind === 'rim-out') xc = rim.cx + (fromLeft ? -1 : 1) * rim.w * 0.48;
  if (kind === 'short') xc = rim.cx - (fromLeft ? 1 : -1) * rim.w * 2.0;
  const vy = -Math.sqrt(2 * g * (y0 - apexY));
  // 0.5 g t² + vy t + (y0 - cy) = 0 → больший корень
  const A = 0.5 * g, B = vy, C = y0 - rim.cy;
  const tc = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
  const vx = (xc - x0) / tc;
  const free = (t) => ({ x: x0 + vx * t, y: y0 + vy * t + 0.5 * g * t * t });
  return (t) => {
    if (t < 0) return null;
    if (t <= tc || kind === 'miss-left' || kind === 'miss-right' || kind === 'short') {
      const p = free(t);
      return p.y > H + ballR * 2 ? null : p;
    }
    const dt = t - tc;
    if (kind === 'make') {
      // В сетке мяч замедляется, затем падает.
      const vyc = vy + g * tc;
      const slow = Math.min(dt, 0.25);
      let x = xc + vx * 0.15 * slow;
      let y = rim.cy + vyc * 0.35 * slow;
      if (dt > 0.25) {
        const d2 = dt - 0.25;
        x += vx * 0.1 * d2;
        y += vyc * 0.35 * d2 + 0.5 * g * d2 * d2;
      }
      return y > H + ballR * 2 ? null : { x, y };
    }
    // rim-out: отскок вверх и в сторону от кольца
    const vyc = vy + g * tc;
    const bvy = -0.45 * vyc;
    const bvx = (fromLeft ? -1 : 1) * Math.abs(vx) * 0.9;
    const p = { x: xc + bvx * dt, y: rim.cy + bvy * dt + 0.5 * g * dt * dt };
    return p.y > H + ballR * 2 ? null : p;
  };
}

/** Рендер кадра в RGBA. ball = {x,y} | null, person = {x} | null */
export function renderFrame(scene, ball, person, frameNo, out) {
  const { W, H, rim, ballR } = scene;
  const data = out || new Uint8ClampedArray(W * H * 4);
  const rand = rng(scene.seed * 7919 + frameNo * 104729);
  // стена + пол
  for (let y = 0; y < H; y++) {
    const floor = y > H * 0.86;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = (rand() * 8 - 4) | 0;
      if (floor) {
        data[i] = 150 + n; data[i + 1] = 140 + n; data[i + 2] = 130 + n;
      } else {
        const v = 95 + ((y / H) * 30) | 0;
        data[i] = v - 10 + n; data[i + 1] = v + n; data[i + 2] = v + 20 + n;
      }
      data[i + 3] = 255;
    }
  }
  const put = (x, y, r, g, b) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  };
  const rect = (x0, y0, x1, y1, r, g, b) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) put(x, y, r, g, b);
  };
  // щит
  const bbw = rim.w * 2.1, bbh = rim.w * 1.25;
  rect(rim.cx - bbw / 2, rim.cy - bbh * 0.95, rim.cx + bbw / 2, rim.cy + bbh * 0.05, 235, 235, 235);
  rect(rim.cx - rim.w * 0.4, rim.cy - rim.w * 0.6, rim.cx + rim.w * 0.4, rim.cy - rim.w * 0.56, 40, 40, 40);
  // человек (тёмный прямоугольник с «головой»)
  if (person) {
    rect(person.x - W * 0.03, H * 0.55, person.x + W * 0.03, H * 0.86, 40, 50, 80);
    for (let dy = -ballR; dy <= ballR; dy++)
      for (let dx = -ballR; dx <= ballR; dx++)
        if (dx * dx + dy * dy <= ballR * ballR * 0.8) put(person.x + dx, H * 0.5 + dy, 170, 120, 95);
  }
  // мяч
  if (ball) {
    const R = ballR;
    for (let dy = -Math.ceil(R); dy <= Math.ceil(R); dy++)
      for (let dx = -Math.ceil(R); dx <= Math.ceil(R); dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R) continue;
        const seam = Math.abs(dx) < 0.6 || Math.abs(dy) < 0.6;
        if (seam) put(ball.x + dx, ball.y + dy, 40, 25, 15);
        else put(ball.x + dx, ball.y + dy, 215, 105, 35);
      }
  }
  // сетка (белые линии, рисуются поверх мяча)
  const netH = rim.w * 0.85;
  for (let k = 0; k <= 6; k++) {
    const xt = rim.cx - rim.w / 2 + (rim.w * k) / 6;
    const xb = rim.cx - rim.w * 0.3 + (rim.w * 0.6 * k) / 6;
    for (let s = 0; s <= 1; s += 1 / netH) put(xt + (xb - xt) * s, rim.cy + netH * s, 240, 240, 240);
  }
  // кольцо — эллипс-обод
  const rx = rim.w / 2, ry = rim.h / 2;
  for (let a = 0; a < Math.PI * 2; a += 0.01) {
    for (let th = -1; th <= 1; th++) {
      put(rim.cx + Math.cos(a) * (rx + th * 0.5), rim.cy + Math.sin(a) * (ry + th * 0.5), 225, 70, 25);
    }
  }
  return data;
}

/**
 * Сценарий: тишина (поиск кольца), затем броски каждые `gap` секунд.
 * Возвращает генератор кадров {data, t, frame}.
 */
export function* scenario(scene, shots, { fps = 30, lead = 2.5, gap = 2.6, tail = 2, person = true } = {}) {
  const total = lead + shots.length * gap + tail;
  const frames = Math.round(total * fps);
  const paths = shots.map((k, i) => shotPath(scene, k, i % 2 === 0));
  const buf = new Uint8ClampedArray(scene.W * scene.H * 4);
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    let ball = null;
    for (let i = 0; i < shots.length; i++) {
      const ts = lead + i * gap;
      if (t >= ts && t < ts + gap) ball = paths[i](t - ts);
    }
    const p = person ? { x: scene.W * (0.1 + 0.05 * Math.sin(t * 1.3)) } : null;
    renderFrame(scene, ball, p, f, buf);
    yield { data: buf, t: t * 1000, frame: f };
  }
}
