// Ядро компьютерного зрения: поиск кольца, отслеживание мяча, распознавание попаданий.
// Работает с уменьшенным RGBA-кадром (≈400 px по длинной стороне), без внешних библиотек.
//
// Идея:
//  • Кольцо — статичный насыщенный оранжево-красный объект, вытянутый по горизонтали (эллипс).
//    Копим «статичность» оранжевых пикселей во времени: мяч пролетает быстро и не накапливается,
//    а кольцо остаётся. Лучший по форме/размеру компонент, стабильный 3 проверки подряд, — кольцо.
//  • Мяч — движущееся пятно (вычитание фона) размером ≈ 0.52 ширины кольца (24 см против 45.7 см),
//    круглое, желательно оранжевое. Несколько треков с предсказанием по скорости и гравитации.
//  • Бросок — трек, поднявшийся выше кольца рядом с ним. Попадание — мяч пересекает линию кольца
//    сверху вниз внутри обода и уходит вниз, не выпрыгнув обратно и не уйдя в сторону.
//    Промах — мяч ушёл ниже кольца мимо обода / отскочил в сторону / потерялся без признаков попадания.

export const BALL_TO_RIM = 0.52;

export const SENSITIVITY = {
  low: { fgThr: 80, minScore: 0.55 },
  medium: { fgThr: 62, minScore: 0.45 },
  high: { fgThr: 46, minScore: 0.36 },
};

const RIM_CHECK_EVERY = 6; // кадров между проверками кольца
const RIM_HITS_TO_LOCK = 3;
const RIM_MISSES_TO_LOSE = 45; // ≈ 9 с при 30 fps

export class ShotDetector {
  constructor(opts = {}) {
    this.sens = SENSITIVITY[opts.sensitivity] || SENSITIVITY.medium;
    this.w = 0;
    this.h = 0;
    this.counting = true; // если false — кольцо и мяч отслеживаются, но броски не засчитываются
    this.reset();
  }

  setSensitivity(name) {
    this.sens = SENSITIVITY[name] || SENSITIVITY.medium;
  }

  reset() {
    this.rim = null;
    this.rimLocked = false;
    this.rimManual = false;
    this._rimCand = null;
    this._rimHits = 0;
    this._rimMiss = 0;
    this.frame = 0;
    this.tracks = [];
    this._nextId = 1;
    this.shot = null;
    this.cooldownUntil = 0;
    this.suspendUntil = 0;
    this.lastT = null;
    this.netScore = 0;
    this._netBase = 0;
    this.bgReady = false;
    this.candidates = [];
    if (this.rimAcc) this.rimAcc.fill(0);
  }

  /** Сброс модели фона (после смены зума/кадрирования). Кольцо сохраняется. */
  resetBackground() {
    this.bgReady = false;
    this.tracks = [];
    this.shot = null;
    if (this.rimAcc) this.rimAcc.fill(0);
    this._rimMiss = 0;
  }

  /** Установить кольцо вручную или после пересчёта координат. rim = {cx, cy, w, h} в координатах кадра обработки. */
  setRim(rim, { manual = false, locked = true } = {}) {
    if (!rim) return this.clearRim();
    this.rim = { ...rim };
    this.rimLocked = locked;
    this.rimManual = manual;
    this._rimMiss = 0;
    this._rimCand = locked ? { ...rim } : null;
    this._rimHits = locked ? RIM_HITS_TO_LOCK : 0;
  }

  clearRim() {
    this.rim = null;
    this.rimLocked = false;
    this.rimManual = false;
    this._rimCand = null;
    this._rimHits = 0;
    this._rimMiss = 0;
    this.shot = null;
  }

  /** Сброс временной шкалы (перемотка видео): треки и бросок сбрасываются, кольцо остаётся. */
  resetTime() {
    this.lastT = null;
    this.tracks = [];
    this.shot = null;
    this.cooldownUntil = 0;
    this.suspendUntil = 0;
    this.bgReady = false;
  }

  /** Отменить текущий бросок и не засчитывать ничего в течение ms. */
  suspend(ms) {
    this.shot = null;
    for (const tr of this.tracks) tr.used = true;
    this.suspendUntil = (this.lastT ?? 0) + ms;
  }

  _alloc(w, h) {
    this.w = w;
    this.h = h;
    const N = w * h;
    this.bg = new Float32Array(N * 3);
    this.gray = new Uint8Array(N);
    this.prev = new Uint8Array(N);
    this.fg = new Uint8Array(N);
    this.warm = new Uint8Array(N);
    this.rimAcc = new Float32Array(N);
    this.maskA = new Uint8Array(N);
    this.maskB = new Uint8Array(N);
    this.labels = new Int32Array(N);
    this.stack = new Int32Array(N);
    this.bgReady = false;
    this.tracks = [];
    this.shot = null;
  }

  /**
   * Обработать кадр.
   * @param {Uint8ClampedArray} data RGBA
   * @param {number} w
   * @param {number} h
   * @param {number} t время, мс
   */
  process(data, w, h, t) {
    const events = [];
    if (w !== this.w || h !== this.h) this._alloc(w, h);
    const N = w * h;
    const dt = this.lastT == null ? 1 / 30 : Math.max(0.005, Math.min(0.25, (t - this.lastT) / 1000));
    this.lastT = t;
    this.frame++;
    const { gray, prev, bg, fg, warm, rimAcc } = this;

    if (!this.bgReady) {
      for (let i = 0, j = 0; i < N; i++, j += 4) {
        const r = data[j], g = data[j + 1], b = data[j + 2];
        const k = i * 3;
        bg[k] = r; bg[k + 1] = g; bg[k + 2] = b;
        const gy = (r * 77 + g * 150 + b * 29) >> 8;
        gray[i] = gy; prev[i] = gy;
        fg[i] = 0;
      }
      this.bgReady = true;
      this._bgFrames = 0;
      this.candidates = [];
      return this._result(events);
    }

    const thr = this.sens.fgThr;
    const a = this._bgFrames < 12 ? 0.25 : 0.035;
    this._bgFrames++;
    let fgCount = 0;

    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const k = i * 3;
      const dr = r - bg[k], dg = g - bg[k + 1], db = b - bg[k + 2];
      const d = (dr < 0 ? -dr : dr) + (dg < 0 ? -dg : dg) + (db < 0 ? -db : db);
      bg[k] += dr * a; bg[k + 1] += dg * a; bg[k + 2] += db * a;
      const isFg = d > thr ? 1 : 0;
      fg[i] = isFg;
      fgCount += isFg;
      prev[i] = gray[i];
      gray[i] = (r * 77 + g * 150 + b * 29) >> 8;

      // «Тёплые» цвета: красный канал максимален, оттенок от −12° до 45°.
      let wb = 0, wr = 0;
      if (r > g && r >= b && r > 40) {
        const mn = g < b ? g : b;
        const c = r - mn;
        if (c > r * 0.28) {
          const hn = g - b; // оттенок = 60° · hn / c
          if (hn > -0.2 * c && hn < 0.75 * c) {
            wb = 1;
            if (c > r * 0.42 && r > 70 && hn < 0.62 * c) wr = 1;
          }
        }
      }
      warm[i] = wb;
      rimAcc[i] += (wr - rimAcc[i]) * 0.06;
    }

    // Резкая смена всего кадра (экспозиция, тряска камеры) — переобучаем фон.
    if (fgCount > N * 0.35) {
      this.bgReady = false;
      this.tracks = [];
      if (this.shot) this.shot = null;
      this.suspendUntil = Math.max(this.suspendUntil, t + 400);
      this.candidates = [];
      return this._result(events);
    }

    if (!this.rimManual && this.frame % RIM_CHECK_EVERY === 0) this._detectRim(events);

    this._measureNet();

    const rim = this.rimLocked ? this.rim : null;
    const D = rim ? rim.w * BALL_TO_RIM : null;
    const cands = this._findBalls(D, rim);
    this.candidates = cands;
    const gpx = rim ? 9.8 * (rim.w / 0.457) : 0;
    this._track(cands, t, gpx, D);

    if (rim && this.counting) this._updateShot(t, events);
    else this.shot = null;

    return this._result(events);
  }

  _result(events) {
    return {
      events,
      rim: this.rim,
      rimLocked: this.rimLocked,
      rimManual: this.rimManual,
      tracks: this.tracks,
      candidates: this.candidates,
      shot: this.shot,
    };
  }

  // ───────────────────────────── Кольцо ─────────────────────────────

  _detectRim(events) {
    const { w, h, rimAcc, maskA, maskB } = this;
    const N = w * h;
    for (let i = 0; i < N; i++) maskA[i] = rimAcc[i] > 0.5 ? 1 : 0;
    // Дилатация 3×3, чтобы склеить разорванные дуги тонкого обода.
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const i = o + x;
        maskB[i] = maskA[i] | (x > 0 ? maskA[i - 1] : 0) | (x < w - 1 ? maskA[i + 1] : 0);
      }
    }
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const i = o + x;
        maskA[i] = maskB[i] | (y > 0 ? maskB[i - w] : 0) | (y < h - 1 ? maskB[i + w] : 0);
      }
    }
    const comps = this._components(maskA, null, 6, 400);
    let best = null, bestScore = 0;
    const minW = Math.max(6, w * 0.02);
    for (const c of comps) {
      const bw = c.maxX - c.minX - 1; // минус расширение дилатацией
      const bh = Math.max(1, c.maxY - c.minY - 1);
      if (bw < minW || bw > w * 0.5) continue;
      const aspect = bw / bh;
      if (aspect < 1.3 || aspect > 14) continue;
      const cy = (c.minY + c.maxY) / 2;
      if (cy > h * 0.88) continue;
      const fill = c.area / ((bw + 2) * (bh + 2));
      let score = bw * Math.min(aspect, 5) / 5;
      if (cy > h * 0.7) score *= 0.5;
      if (fill > 0.85 && bw * bh > 600) score *= 0.5; // сплошная оранжевая плашка, а не обод
      if (score > bestScore) {
        bestScore = score;
        best = { cx: (c.minX + c.maxX) / 2, cy, w: bw, h: bh };
      }
    }

    const similar = (p, q) => {
      if (!p || !q) return false;
      const m = Math.max(p.w, q.w);
      const r = p.w / q.w;
      return Math.abs(p.cx - q.cx) < 0.35 * m && Math.abs(p.cy - q.cy) < 0.35 * m && r > 0.7 && r < 1.43;
    };

    if (!this.rimLocked) {
      if (best && similar(best, this._rimCand)) this._rimHits++;
      else this._rimHits = best ? 1 : 0;
      this._rimCand = best;
      if (this._rimHits >= RIM_HITS_TO_LOCK) {
        this.rim = { ...best };
        this.rimLocked = true;
        this._rimMiss = 0;
        events.push({ type: 'rim-found', rim: { ...best } });
      }
    } else {
      if (best && similar(best, this.rim)) {
        const k = 0.15;
        this.rim.cx += (best.cx - this.rim.cx) * k;
        this.rim.cy += (best.cy - this.rim.cy) * k;
        this.rim.w += (best.w - this.rim.w) * k;
        this.rim.h += (best.h - this.rim.h) * k;
        this._rimMiss = 0;
      } else {
        this._rimMiss++;
        if (this._rimMiss > RIM_MISSES_TO_LOSE) {
          this.rim = null;
          this.rimLocked = false;
          this._rimHits = 0;
          this._rimCand = null;
          this.shot = null;
          events.push({ type: 'rim-lost' });
        }
      }
    }
  }

  /** Оценка ближайшего к точке «кольцеподобного» объекта — для ручной разметки касанием. */
  rimNear(x, y) {
    if (!this.rimAcc) return null;
    const { w, h, rimAcc, maskA } = this;
    const N = w * h;
    for (let i = 0; i < N; i++) maskA[i] = rimAcc[i] > 0.3 ? 1 : 0;
    const comps = this._components(maskA, null, 4, 400);
    let best = null, bd = Infinity;
    for (const c of comps) {
      const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
      if (bw < 5 || bw / bh < 1.1 || bw > w * 0.5) continue;
      const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
      const d = Math.hypot(cx - x, cy - y);
      if (d < Math.max(bw, w * 0.06) && d < bd) {
        bd = d;
        best = { cx, cy, w: bw, h: bh };
      }
    }
    return best;
  }

  // ───────────────────────────── Сетка ─────────────────────────────

  _measureNet() {
    const rim = this.rimLocked ? this.rim : null;
    if (!rim) {
      this.netScore = 0;
      return;
    }
    const { w, h, gray, prev } = this;
    const x0 = Math.max(0, Math.round(rim.cx - rim.w * 0.4));
    const x1 = Math.min(w - 1, Math.round(rim.cx + rim.w * 0.4));
    const y0 = Math.max(0, Math.round(rim.cy + rim.h * 0.5 + 1));
    const y1 = Math.min(h - 1, Math.round(rim.cy + rim.w * 0.85));
    let moved = 0, total = 0;
    for (let y = y0; y <= y1; y++) {
      const o = y * w;
      for (let x = x0; x <= x1; x++) {
        const d = gray[o + x] - prev[o + x];
        if (d > 18 || d < -18) moved++;
        total++;
      }
    }
    const frac = total ? moved / total : 0;
    if (!this.shot) this._netBase += (frac - this._netBase) * 0.05;
    this.netScore = Math.max(0, frac - this._netBase);
  }

  // ───────────────────────────── Мяч ─────────────────────────────

  _findBalls(D, rim) {
    const { w, h } = this;
    const minArea = D ? Math.max(3, Math.round(0.12 * D * D)) : 4;
    const comps = this._components(this.fg, this.warm, minArea, 600);
    const out = [];
    const maxFree = 0.12 * Math.min(w, h);
    for (const c of comps) {
      const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
      const x = c.sx / c.area, y = c.sy / c.area;
      if (rim) {
        if (Math.abs(x - rim.cx) > rim.w * 6 || y > rim.cy + rim.w * 4) continue;
      }
      const eqD = 2 * Math.sqrt(c.area / Math.PI);
      if (D) {
        if (eqD < 0.4 * D || eqD > 1.9 * D) continue;
        if (Math.max(bw, bh) > 3.2 * D) continue;
      } else if (eqD < 3 || eqD > maxFree) continue;
      const fill = c.area / (bw * bh);
      if (fill < 0.3) continue;
      const round = Math.min(bw, bh) / Math.max(bw, bh);
      const color = c.warm / c.area;
      const sizeScore = D ? Math.max(0, 1 - Math.abs(Math.log(eqD / D)) / Math.log(2.2)) : 0.5;
      const score = 0.35 * sizeScore + 0.3 * round + 0.2 * Math.min(1, fill / 0.78) + 0.25 * Math.min(1, color * 1.5);
      out.push({ x, y, d: eqD, score });
    }
    return out;
  }

  _track(cands, t, g, D) {
    const tracks = this.tracks;
    for (const tr of tracks) {
      const L = tr.pts[tr.pts.length - 1];
      const dtt = (t - L.t) / 1000;
      tr.px = L.x + tr.vx * dtt;
      tr.py = L.y + tr.vy * dtt + 0.5 * g * dtt * dtt;
      const sp = Math.hypot(tr.vx, tr.vy);
      const d = D || tr.d;
      tr.gate = Math.max(2.5 * d, 1.5 * d + 0.6 * sp * dtt);
    }
    const pairs = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const tr = tracks[ti];
      for (let ci = 0; ci < cands.length; ci++) {
        const c = cands[ci];
        const dist = Math.hypot(c.x - tr.px, c.y - tr.py);
        if (dist < tr.gate) pairs.push([dist / tr.gate - 0.3 * c.score, ti, ci]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const tUsed = new Uint8Array(tracks.length);
    const cUsed = new Uint8Array(cands.length);
    for (const [, ti, ci] of pairs) {
      if (tUsed[ti] || cUsed[ci]) continue;
      tUsed[ti] = 1;
      cUsed[ci] = 1;
      const tr = tracks[ti], c = cands[ci];
      const L = tr.pts[tr.pts.length - 1];
      const dtt = Math.max(0.005, (t - L.t) / 1000);
      const nvx = (c.x - L.x) / dtt, nvy = (c.y - L.y) / dtt;
      if (tr.pts.length === 1) {
        tr.vx = nvx;
        tr.vy = nvy;
      } else {
        tr.vx = 0.35 * tr.vx + 0.65 * nvx;
        tr.vy = 0.35 * tr.vy + 0.65 * nvy;
      }
      tr.travel += Math.hypot(c.x - L.x, c.y - L.y);
      tr.d = 0.8 * tr.d + 0.2 * c.d;
      tr.pts.push({ x: c.x, y: c.y, t });
      if (tr.pts.length > 90) tr.pts.shift();
      tr.lastSeen = t;
    }
    for (let ti = tracks.length - 1; ti >= 0; ti--) {
      if (!tUsed[ti] && t - tracks[ti].lastSeen > 350) tracks.splice(ti, 1);
    }
    const minScore = this.sens.minScore;
    for (let ci = 0; ci < cands.length; ci++) {
      if (cUsed[ci] || cands[ci].score < minScore) continue;
      const c = cands[ci];
      tracks.push({
        id: this._nextId++,
        pts: [{ x: c.x, y: c.y, t }],
        vx: 0,
        vy: 0,
        d: c.d,
        lastSeen: t,
        born: t,
        travel: 0,
        used: false,
      });
    }
    if (tracks.length > 8) {
      tracks.sort((p, q) => q.lastSeen - p.lastSeen || q.pts.length - p.pts.length);
      tracks.length = 8;
    }
  }

  // ───────────────────────────── Логика броска ─────────────────────────────

  _updateShot(t, events) {
    const R = this.rim;
    const cx = R.cx, cy = R.cy, W = R.w, hw = W / 2, D = W * BALL_TO_RIM;

    if (!this.shot) {
      if (t < this.cooldownUntil || t < this.suspendUntil) return;
      for (const tr of this.tracks) {
        if (tr.used || tr.pts.length < 3 || tr.lastSeen !== t) continue;
        const p = tr.pts[tr.pts.length - 1];
        if (p.y < cy - 0.25 * D && Math.abs(p.x - cx) < 3 * W && tr.travel > 1.5 * D) {
          tr.used = true;
          this.shot = {
            track: tr,
            start: t,
            near: false,
            crossIn: null,
            rimTouch: false,
            last: p,
            lastSeen: t,
            netPeak: 0,
            pts: [p],
          };
          break;
        }
      }
      if (!this.shot) return;
    }

    const s = this.shot;
    const decide = (type) => {
      this.shot = null;
      this.cooldownUntil = t + 700;
      if (type !== 'cancel') events.push({ type, t, pts: s.pts });
    };

    // Если мяч потерян (перекрыт кольцом/щитом), подхватываем новый трек рядом с последней позицией.
    if (!this.tracks.includes(s.track) || s.track.lastSeen !== t) {
      for (const o of this.tracks) {
        if (o === s.track || o.lastSeen !== t || o.pts.length > 5) continue;
        if (o.used && o !== s.track) continue;
        const p = o.pts[o.pts.length - 1];
        if (Math.hypot(p.x - s.last.x, p.y - s.last.y) < 2.5 * W && t - s.lastSeen < 800) {
          s.track = o;
          o.used = true;
          break;
        }
      }
    }

    const tr = s.track;
    if (tr.lastSeen === t) {
      const p = tr.pts[tr.pts.length - 1];
      const q = s.last;
      s.last = p;
      s.lastSeen = t;
      s.pts.push(p);
      if (Math.abs(p.x - cx) < 2.5 * W && p.y < cy + 0.6 * W) s.near = true;

      if (q.y < cy && p.y >= cy) {
        const f = (cy - q.y) / (p.y - q.y);
        const xc = q.x + f * (p.x - q.x);
        const off = Math.abs(xc - cx);
        if (off < hw * 0.8) {
          if (!s.crossIn) s.crossIn = { t, x: xc };
        } else if (off > hw + 1.5 * D) {
          return decide(s.near ? 'miss' : 'cancel');
        } else {
          s.rimTouch = true;
        }
      }
      if (s.crossIn && p.y < cy - 0.5 * D) s.crossIn = null; // выпрыгнул обратно вверх
      if (s.crossIn && Math.abs(p.x - cx) > 1.3 * W) s.crossIn = null; // ушёл в сторону — был перед/за кольцом
      if (s.crossIn && p.y > cy + 0.9 * W) return decide('make');
      if (!s.crossIn && p.y > cy + 0.9 * W) return decide(s.near ? 'miss' : 'cancel');
      if (Math.abs(p.x - cx) > 5 * W) return decide(s.near ? 'miss' : 'cancel');
    }

    if (s.near || s.crossIn) s.netPeak = Math.max(s.netPeak, this.netScore);

    const lostFor = t - s.lastSeen;
    if (s.crossIn) {
      // Мяч прошёл обод вниз и пропал в сетке / не вернулся — попадание.
      if (lostFor > 450 || t - s.crossIn.t > 900) return decide('make');
    } else if (lostFor > 900) {
      const p = s.last;
      const descending = tr.vy > 0;
      if (p.y < cy + 0.3 * W && Math.abs(p.x - cx) < hw && descending && s.netPeak > 0.12) return decide('make');
      return decide(s.near ? 'miss' : 'cancel');
    }
    if (t - s.start > 5000) return decide(s.crossIn ? 'make' : s.near ? 'miss' : 'cancel');
  }

  // ───────────────────────────── Связные компоненты ─────────────────────────────

  _components(mask, warm, minArea, maxComps) {
    const { w, h, labels, stack } = this;
    const N = w * h;
    labels.fill(0);
    const comps = [];
    let lab = 0;
    for (let i = 0; i < N; i++) {
      if (!mask[i] || labels[i]) continue;
      lab++;
      let sp = 0;
      stack[sp++] = i;
      labels[i] = lab;
      let area = 0, minX = w, maxX = 0, minY = h, maxY = 0, sx = 0, sy = 0, wc = 0;
      while (sp) {
        const j = stack[--sp];
        const y = (j / w) | 0;
        const x = j - y * w;
        area++;
        sx += x;
        sy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (warm && warm[j]) wc++;
        const x0 = x > 0 ? -1 : 0, x1 = x < w - 1 ? 1 : 0;
        const y0 = y > 0 ? -1 : 0, y1 = y < h - 1 ? 1 : 0;
        for (let dy = y0; dy <= y1; dy++) {
          const row = j + dy * w;
          for (let dx = x0; dx <= x1; dx++) {
            const k = row + dx;
            if (mask[k] && !labels[k]) {
              labels[k] = lab;
              stack[sp++] = k;
            }
          }
        }
      }
      if (area >= minArea) {
        comps.push({ area, minX, maxX, minY, maxY, sx, sy, warm: wc });
        if (comps.length >= maxComps) break;
      }
    }
    return comps;
  }
}
