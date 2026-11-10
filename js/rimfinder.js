// Поиск кольца по форме, без опоры на цвет.
//
// Признаки (на полутоновом изображении, лучше усреднённом во времени, чтобы убрать движение):
//  • сетка — под ободом много «диагональных» перепадов яркости (ромбовидное плетение),
//    а слева/справа от сетки, над ободом и ниже сетки такого узора нет;
//  • обод — горизонтальная линия по верху сетки;
//  • щит — стандартный прямоугольник 183×105 см и внутренний квадрат 59×45 см над кольцом
//    (кольцо 45 см). Камера сбоку сжимает щит по горизонтали и сдвигает его относительно кольца.
// Поиск скользящим окном по масштабам через интегральные изображения (~50–100 мс на 800 px).

export class RimFinder {
  constructor() {
    this.w = 0;
    this.h = 0;
  }

  _alloc(w, h) {
    this.w = w;
    this.h = h;
    const N1 = (w + 1) * (h + 1);
    this.iD = new Float64Array(N1); // диагональные края (нити сетки)
    this.iH = new Float64Array(N1); // горизонтальные края (обод, рамка щита)
    this.iV = new Float64Array(N1); // вертикальные края (рамка щита)
    this.iE = new Float64Array(N1); // любые края
  }

  /** Построить карты краёв. Вызывается перед candidates()/scoreAt(). */
  analyze(gray, w, h) {
    if (w !== this.w || h !== this.h) this._alloc(w, h);
    const { iD, iH, iV, iE } = this;
    const W1 = w + 1;
    let sumG = 0, cnt = 0;
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const i = y * w + x;
        sumG += Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + w] - gray[i - w]);
        cnt++;
      }
    }
    const thr = Math.max(10, Math.min(40, (sumG / Math.max(1, cnt)) * 1.2));
    for (let x = 0; x <= w; x++) iD[x] = iH[x] = iV[x] = iE[x] = 0;
    for (let y = 1; y <= h; y++) {
      let rD = 0, rH = 0, rV = 0, rE = 0;
      const k0 = y * W1;
      iD[k0] = iH[k0] = iV[k0] = iE[k0] = 0;
      const py = y - 1;
      for (let x = 1; x <= w; x++) {
        const px = x - 1;
        if (px > 0 && py > 0 && px < w - 1 && py < h - 1) {
          const i = py * w + px;
          const gx = gray[i + 1] - gray[i - 1];
          const gy = gray[i + w] - gray[i - w];
          const ax = gx < 0 ? -gx : gx, ay = gy < 0 ? -gy : gy;
          if (ax + ay > thr) {
            rE++;
            const mn = ax < ay ? ax : ay, mx = ax < ay ? ay : ax;
            if (mn > mx * 0.35) rD++;
            else if (ay > ax * 2.5) rH++;
            else if (ax > ay * 2.5) rV++;
          }
        }
        const k = k0 + x, up = k - W1;
        iD[k] = rD + iD[up];
        iH[k] = rH + iH[up];
        iV[k] = rV + iV[up];
        iE[k] = rE + iE[up];
      }
    }
  }

  _box(I, x0, y0, x1, y1) {
    const { w, h } = this;
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(w, Math.round(x1)); y1 = Math.min(h, Math.round(y1));
    if (x1 <= x0 || y1 <= y0) return -1;
    const W1 = w + 1;
    return (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
  }

  /** Признаки сетки и обода (cx, cy — центр верха обода, rw — ширина кольца). */
  _netScore(cx, cy, rw) {
    const { iD, iH, iE } = this;
    const b = (I, a, c, d, e) => this._box(I, a, c, d, e);
    const half = rw * 0.38;
    const dN = b(iD, cx - half, cy + rw * 0.12, cx + half, cy + rw * 0.72);
    if (dN < 0.1) return null;
    const eN = b(iE, cx - half, cy + rw * 0.12, cx + half, cy + rw * 0.72);
    const dL = b(iD, cx - rw * 1.05, cy + rw * 0.12, cx - rw * 0.62, cy + rw * 0.72);
    const dR = b(iD, cx + rw * 0.62, cy + rw * 0.12, cx + rw * 1.05, cy + rw * 0.72);
    const dB = b(iD, cx - half, cy + rw * 1.0, cx + half, cy + rw * 1.4);
    const sides = Math.max(dL < 0 ? 0 : dL, dR < 0 ? 0 : dR);
    const below = dB < 0 ? 0.05 : dB;
    const hT = Math.max(0, b(iH, cx - rw * 0.42, cy - rw * 0.08, cx + rw * 0.42, cy + rw * 0.08));
    const dA = Math.max(0, b(iD, cx - half, cy - rw * 0.55, cx + half, cy - rw * 0.12));
    const score = dN * Math.min(1, dN / Math.max(eN, 1e-6) + 0.3) - 0.9 * sides - 0.6 * below - 0.8 * dA + 0.25 * hT;
    return { cx, cy, w: rw, score, dN };
  }

  /** Насколько вокруг кандидата виден щит стандартных пропорций (0…~1). */
  _boardScore(cx, cy, rw) {
    const { iH, iV } = this;
    const tol = Math.max(1, Math.round(rw * 0.1));
    const vline = (x, y0, y1) => {
      let m = 0;
      for (let dx = -tol; dx <= tol; dx++) m = Math.max(m, this._box(iV, x + dx - 1, y0, x + dx + 1, y1));
      return m;
    };
    const hline = (y, x0, x1, t) => {
      let m = 0;
      for (let dy = -t; dy <= t; dy++) m = Math.max(m, this._box(iH, x0, y + dy - 1, x1, y + dy + 1));
      return m;
    };
    let best = 0;
    for (const k of [1, 0.85, 0.7, 0.55]) {
      const shiftMax = 0.8 * rw * Math.sqrt(1 - k * k);
      for (const sh of k === 1 ? [0] : [-shiftMax, -shiftMax / 2, 0, shiftMax / 2, shiftMax]) {
        const bx = cx + sh;
        const a = 0.65 * rw * k, A = 2.0 * rw * k;
        const iL = vline(bx - a, cy - rw * 0.95, cy - rw * 0.1);
        const iR = vline(bx + a, cy - rw * 0.95, cy - rw * 0.1);
        const iT = hline(cy - rw * 1.0, bx - a, bx + a, tol);
        const inner = (2 * Math.min(iL, iR) + iT) / 3;
        const oL = vline(bx - A, cy - rw * 1.8, cy + rw * 0.2);
        const oR = vline(bx + A, cy - rw * 1.8, cy + rw * 0.2);
        const oB = hline(cy + rw * 0.33, bx - A, bx + A, tol + 1);
        const outer = (2 * Math.min(oL, oR) + oB) / 3;
        const v = Math.max(inner, outer, (inner + outer) / 2 + 0.15);
        if (v > best) best = v;
      }
    }
    return best;
  }

  _total(c) {
    // Ширина перебирается с шагом 12%, а рамка щита стоит в 2 ширинах от центра — уточняем масштаб.
    // и заодно ширину кольца: щит стандартный, поэтому по нему ширина определяется точнее, чем по сетке.
    let bk = 1;
    c.board = -1;
    for (const k of [0.9, 1, 1.1, 1.2, 1.3, 1.4]) {
      const v = this._boardScore(c.cx, c.cy, c.w * k);
      if (v > c.board + 0.02) {
        c.board = v;
        bk = k;
      }
    }
    if (c.board >= 0.6) c.w *= bk;
    const net = Math.min(1, c.dN / 0.3);
    // Щит и обод учитываются только вместе с выраженной сеткой — иначе это линии разметки и т. п.
    c.total = c.dN < 0.16 ? 0 : (c.score + c.board) * net;
    return c;
  }

  /**
   * Уточнить высоту обода (плоскость кольца): находим, где начинается плетение сетки, и берём центр
   * горизонтальных линий обода вокруг этого места. Эллипс обода даёт две линии (задняя и передняя дуги),
   * середина между ними — плоскость кольца. Самая сильная горизонталь бывает узлами сетки — не годится.
   */
  _refine(c) {
    const { iD, iH } = this;
    const x0 = c.cx - c.w * 0.38, x1 = c.cx + c.w * 0.38, band = Math.max(2, c.w * 0.25);
    const ys = [], below = [], line = [];
    for (let y = Math.round(c.cy - c.w * 0.45); y <= c.cy + c.w * 0.35; y++) {
      const b = this._box(iD, x0, y, x1, y + band);
      if (b < 0) continue;
      ys.push(y);
      below.push(b);
      line.push(Math.max(0, this._box(iH, c.cx - c.w * 0.42, y - 1, c.cx + c.w * 0.42, y + 2)));
    }
    let row = c.cy;
    if (ys.length) {
      const mx = Math.max(...below);
      const k = below.findIndex((v) => v >= mx * 0.5);
      const onset = ys[Math.max(0, k)];
      let sw = 0, sy = 0;
      ys.forEach((y, i) => {
        if (y >= onset - c.w * 0.15 && y <= onset + c.w * 0.2) {
          sw += line[i];
          sy += line[i] * y;
        }
      });
      row = sw > 0.3 ? sy / sw : onset;
    }
    return { cx: c.cx, cy: row, w: c.w, h: Math.max(2, c.w * 0.2), total: c.total, board: c.board, dN: c.dN };
  }

  /** Все кандидаты (после подавления пересечений), по убыванию уверенности. */
  candidates(limit = 40, minW = Math.max(12, Math.min(this.w, this.h) * 0.03), maxW = Math.min(this.w, this.h) * 0.45) {
    const { w, h } = this;
    const cands = [];
    for (let rw = minW; rw <= maxW; rw *= 1.12) {
      const step = Math.max(1, Math.round(rw / 10));
      for (let cy = Math.round(rw * 0.3); cy < h * 0.85 - rw * 0.75; cy += step) {
        for (let cx = Math.round(rw * 0.5); cx < w - rw * 0.5; cx += step) {
          const c = this._netScore(cx, cy, rw);
          if (c && c.score > 0.05) cands.push(c);
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const top = [];
    for (const c of cands) {
      if (top.some((t) => Math.abs(t.cx - c.cx) < Math.max(t.w, c.w) * 0.7 && Math.abs(t.cy - c.cy) < Math.max(t.w, c.w) * 0.7)) continue;
      top.push(c);
      if (top.length >= limit) break;
    }
    for (const c of top) this._total(c);
    top.sort((a, b) => b.total - a.total);
    return top.map((c) => this._refine(c));
  }

  /** Проверить конкретного кандидата (например, найденного по цвету): лучшее совпадение рядом. */
  scoreAt(cx, cy, rw) {
    let best = null;
    for (const k of [0.8, 0.9, 1, 1.12, 1.25]) {
      const ww = rw * k, step = Math.max(1, Math.round(ww / 10));
      for (let dy = -ww * 0.25; dy <= ww * 0.25; dy += step) {
        for (let dx = -ww * 0.2; dx <= ww * 0.2; dx += step) {
          const c = this._netScore(cx + dx, cy + dy, ww);
          if (c && (!best || c.score > best.score)) best = c;
        }
      }
    }
    const board = this._boardScore(cx, cy, rw); // кольцо без сетки — проверяем хотя бы щит
    if (!best) return { cx, cy, w: rw, h: rw * 0.2, total: 0, board, dN: 0 };
    const r = this._refine(this._total(best));
    return { ...r, board: Math.max(board, r.board) };
  }

  /** Лучший кандидат или null. */
  find(gray, w, h) {
    this.analyze(gray, w, h);
    const top = this.candidates();
    return top.length && top[0].total >= 0.25 ? { ...top[0], score: top[0].total, top } : null;
  }
}

function half(src, w, h) {
  const w2 = w >> 1, h2 = h >> 1, out = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w, r1 = r0 + w;
    for (let x = 0; x < w2; x++) {
      const i = 2 * x;
      out[y * w2 + x] = (src[r0 + i] + src[r0 + i + 1] + src[r1 + i] + src[r1 + i + 1] + 2) >> 2;
    }
  }
  return { g: out, w: w2, h: h2 };
}

const LEVEL_MAX_W = 64; // на каждом уровне пирамиды ищем кольца шириной 12…64 px

/**
 * Поиск кольца на пирамиде масштабов: на каком-то уровне кольцо всегда 12–64 px,
 * где плотность нитей сетки стабильна. Решение принимается по одному статичному кадру.
 */
export class RimLocator {
  constructor() {
    this.finders = [];
  }

  _levels(gray, w, h) {
    const levels = [];
    let cur = { g: gray, w, h }, scale = 1;
    while (true) {
      levels.push({ ...cur, scale });
      if (Math.min(cur.w, cur.h) / 2 < 70) break;
      cur = half(cur.g, cur.w, cur.h);
      scale *= 2;
    }
    return levels;
  }

  /** Все кандидаты всех уровней в координатах исходного изображения. */
  candidates(gray, w, h) {
    const out = [];
    this._levels(gray, w, h).forEach((L, i) => {
      const f = (this.finders[i] ||= new RimFinder());
      f.analyze(L.g, L.w, L.h);
      const minW = i === 0 ? Math.max(12, Math.min(L.w, L.h) * 0.03) : LEVEL_MAX_W / 2.2;
      const maxW = Math.min(LEVEL_MAX_W, Math.min(L.w, L.h) * 0.45);
      for (const c of f.candidates(30, minW, maxW)) {
        out.push({ ...c, cx: c.cx * L.scale, cy: c.cy * L.scale, w: c.w * L.scale, h: c.h * L.scale, level: i });
      }
    });
    out.sort((a, b) => b.total - a.total);
    // подавление дублей между уровнями
    const res = [];
    for (const c of out) {
      if (res.some((t) => Math.abs(t.cx - c.cx) < Math.max(t.w, c.w) * 0.6 && Math.abs(t.cy - c.cy) < Math.max(t.w, c.w) * 0.6)) continue;
      res.push(c);
    }
    return res;
  }

  /** Кольцо рядом с точкой касания (x, y) — для ручного указания: уточняет положение и размер. */
  near(gray, w, h, x, y) {
    let best = null, bd = Infinity;
    for (const c of this.candidates(gray, w, h)) {
      if (c.total < 0.2) continue;
      const d = Math.hypot(c.cx - x, c.cy + c.w * 0.2 - y);
      if (d < Math.max(c.w * 1.2, Math.min(w, h) * 0.08) && d - c.total * c.w * 0.5 < bd) {
        bd = d - c.total * c.w * 0.5;
        best = c;
      }
    }
    return best;
  }

  /**
   * colorCand — кандидат по оранжевому цвету (в тех же координатах) или null.
   * Возвращает {cx, cy, w, h, source, total} или null.
   */
  locate(gray, w, h, colorCand = null) {
    const top = this.candidates(gray, w, h);
    const [a, b] = top;
    if (a) {
      const margin = a.total - (b ? b.total : 0);
      if (a.total >= 1.0 && (margin >= 0.15 || a.total >= 1.35)) return { ...a, source: 'shape' };
    }
    if (colorCand) {
      // Оранжевый объект принимаем, только если под ним действительно сетка (а не пол/панели).
      const levels = this._levels(gray, w, h);
      let i = 0;
      while (i < levels.length - 1 && colorCand.w / levels[i].scale > LEVEL_MAX_W) i++;
      const L = levels[i], f = this.finders[i];
      f.analyze(L.g, L.w, L.h);
      const s = f.scoreAt(colorCand.cx / L.scale, colorCand.cy / L.scale, colorCand.w / L.scale);
      if (s.total >= 0.9) return { ...s, cx: s.cx * L.scale, cy: s.cy * L.scale, w: s.w * L.scale, h: s.h * L.scale, source: 'color+net' };
    }
    return null;
  }
}

/** Совместимость со старым API (один уровень). */
export function locateRim(_finder, gray, w, h, colorCand = null) {
  return new RimLocator().locate(gray, w, h, colorCand);
}
