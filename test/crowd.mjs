// Групповая тренировка: несколько человек бросают в одно кольцо, мячи летят одновременно,
// под кольцом прыгают на подбор, по площадке ведут мячи. Даёт кадры и эталон (что было на самом деле).
import { shotPath, renderFrame } from './synth.mjs';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const KINDS = ['make', 'make', 'make', 'miss-left', 'miss-right', 'rim-out', 'rim-out', 'short'];
const BALL_COLORS = [[215, 105, 35], [190, 95, 40], [170, 85, 45], [225, 120, 50], [160, 70, 35]];

/**
 * @param scene makeScene(...)
 * @param o.duration   длительность, с
 * @param o.shooters   сколько человек бросает (каждый со своей точки)
 * @param o.gap        средний интервал между бросками одного игрока, с
 * @param o.minSep     минимальный интервал между любыми бросками, с (0 — допускаются одновременные)
 * @param o.walkers    сколько людей ходит по площадке
 * @param o.rebounders прыгают ли на подбор под кольцом
 * @param o.dribblers  сколько мячей ведут по площадке
 * @param o.passes     передачи над площадкой (ниже кольца)
 */
export function crowdScenario(scene, o = {}) {
  const { W, H, rim } = scene;
  const r = rng(o.seed ?? 7);
  const duration = o.duration ?? 40;
  const fps = o.fps ?? 30;
  const lead = o.lead ?? 3;
  const nShooters = o.shooters ?? 4;
  // игроки стоят в разных местах: углы, фланги, центр, ближе/дальше
  const shooters = Array.from({ length: nShooters }, (_, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const x0 = Math.min(W * 0.97, Math.max(W * 0.03, rim.cx + side * W * (0.18 + 0.38 * r())));
    return { x0, y0: H * (0.55 + 0.15 * r()), apex: 1.8 + 1.4 * r(), next: lead + r() * (o.gap ?? 4) };
  });
  const shots = [];
  let lastStart = -1e9;
  for (const sh of shooters) {
    let t = sh.next;
    while (t < duration - 3) {
      shots.push({ t0: t, sh });
      t += (o.gap ?? 4) * (0.6 + 0.8 * r());
    }
  }
  shots.sort((a, b) => a.t0 - b.t0);
  const kept = [];
  for (const s of shots) {
    if (s.t0 - lastStart < (o.minSep ?? 0)) continue;
    lastStart = s.t0;
    const kind = KINDS[Math.floor(r() * KINDS.length)];
    const fromLeft = s.sh.x0 < rim.cx;
    const jitter = (r() - 0.5) * rim.w * 0.25; // разброс точки входа для попаданий
    const path = shotPath(scene, kind, fromLeft, { x0: s.sh.x0 + jitter, y0: s.sh.y0, apex: s.sh.apex });
    kept.push({ t0: s.t0, kind, path, color: BALL_COLORS[Math.floor(r() * BALL_COLORS.length)], tc: s.t0 + path.tc });
  }
  const truth = kept.map((s) => ({ t: s.tc * 1000, type: s.kind === 'make' ? 'make' : 'miss', kind: s.kind }));

  // ходящие люди
  const walkers = Array.from({ length: o.walkers ?? 3 }, () => ({
    x: W * r(), v: (r() - 0.5) * W * 0.25, color: [30 + 60 * r(), 40 + 50 * r(), 60 + 80 * r()].map(Math.round),
  }));
  // мячи, которые ведут по площадке
  const dribblers = Array.from({ length: o.dribblers ?? 0 }, () => ({ x: W * r(), v: (r() - 0.5) * W * 0.2, ph: r() * 6 }));
  const reb = o.rebounders ?? true;

  function* frames() {
    const total = Math.round(duration * fps);
    const buf = new Uint8ClampedArray(W * H * 4);
    for (let f = 0; f < total; f++) {
      const t = f / fps;
      const balls = [];
      for (const s of kept) {
        if (t < s.t0) continue;
        const p = s.path(t - s.t0);
        if (p) balls.push({ ...p, color: s.color });
      }
      const people = [];
      for (const w of walkers) {
        let x = w.x + w.v * t;
        const span = W * 1.1;
        x = ((x % span) + span) % span - W * 0.05;
        people.push({ x, color: w.color });
      }
      for (const d of dribblers) {
        let x = d.x + d.v * t;
        x = ((x % W) + W) % W;
        people.push({ x, color: [60, 60, 60] });
        // мяч стучит об пол: от руки (≈0.68H) до пола (0.86H)
        const ph = Math.abs(Math.sin(t * 5 + d.ph));
        balls.push({ x: x + W * 0.035, y: H * 0.86 - ballRad(scene) - ph * H * 0.16 });
      }
      if (reb) {
        // игрок под кольцом: ждёт подбор и прыгает после каждого броска
        let jump = 0;
        for (const s of kept) {
          const dt = t - s.tc;
          if (dt > 0.1 && dt < 0.9) jump = Math.max(jump, Math.sin(((dt - 0.1) / 0.8) * Math.PI));
        }
        people.push({ x: rim.cx - rim.w * 0.9 + Math.sin(t * 0.7) * rim.w * 0.6, headY: H * 0.5 - jump * H * 0.12, armsUp: jump > 0.3, color: [120, 30, 30] });
      }
      if (o.passes) {
        // передача: мяч летит почти горизонтально на высоте плеч, ниже кольца
        const pt = t % 3.1;
        if (pt < 0.8) balls.push({ x: W * 0.1 + (pt / 0.8) * W * 0.8, y: H * 0.58 - Math.sin((pt / 0.8) * Math.PI) * H * 0.05 });
      }
      renderFrame(scene, balls, people, f, buf);
      yield { data: buf, t: t * 1000, frame: f };
    }
  }
  return { frames, truth, shots: kept };
}

function ballRad(scene) {
  return scene.ballR;
}

/**
 * Сопоставить события детектора с эталоном: глобально по минимальной «стоимости» пары
 * (несовпадение исхода — большой штраф, разница во времени — малый), каждое событие — одному броску.
 */
export function evaluate(truth, events) {
  const evs = events.filter((e) => e.type === 'make' || e.type === 'miss');
  const pairs = [];
  truth.forEach((tr, i) => {
    evs.forEach((e, j) => {
      // решение принимается от чуть раньше пересечения линии кольца до ~2.2 с после
      if (e.t < tr.t - 400 || e.t > tr.t + 2200) return;
      pairs.push({ i, j, cost: (e.type === tr.type ? 0 : 10) + Math.abs(e.t - (tr.t + 400)) / 1000 });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost);
  const ti = new Array(truth.length).fill(-1), ej = new Array(evs.length).fill(-1);
  for (const p of pairs) {
    if (ti[p.i] >= 0 || ej[p.j] >= 0) continue;
    ti[p.i] = p.j;
    ej[p.j] = p.i;
  }
  const res = { total: truth.length, correct: 0, wrongType: 0, missed: 0, extra: 0, truthMakes: 0, detMakes: 0, details: [] };
  truth.forEach((tr, i) => {
    if (tr.type === 'make') res.truthMakes++;
    if (ti[i] < 0) {
      res.missed++;
      res.details.push({ t: tr.t, kind: tr.kind, got: '—' });
    } else if (evs[ti[i]].type === tr.type) res.correct++;
    else {
      res.wrongType++;
      res.details.push({ t: tr.t, kind: tr.kind, got: evs[ti[i]].type });
    }
  });
  evs.forEach((e, j) => {
    if (e.type === 'make') res.detMakes++;
    if (ej[j] < 0) {
      res.extra++;
      res.details.push({ t: e.t, kind: 'лишнее', got: e.type });
    }
  });
  return res;
}
