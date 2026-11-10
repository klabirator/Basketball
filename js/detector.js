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

function _similar(p, q) {
  if (!p || !q) return false;
  const m = Math.max(p.w, q.w);
  const r = p.w / q.w;
  return Math.abs(p.cx - q.cx) < 0.35 * m && Math.abs(p.cy - q.cy) < 0.35 * m && r > 0.7 && r < 1.43;
}

export class ShotDetector {
  constructor(opts = {}) {
    this.sens = SENSITIVITY[opts.sensitivity] || SENSITIVITY.medium;
    this.w = 0;
    this.h = 0;
    this.counting = true; // если false — кольцо и мяч отслеживаются, но броски не засчитываются
    // Фиксировать кольцо только по оранжевому цвету. В приложении выключено: цвет лишь предлагает
    // кандидата, а подтверждает его поиск по форме (сетка + щит) — см. offerRim() и rimfinder.js.
    this.colorAutoLock = opts.colorAutoLock ?? true;
    this.reset();
  }

  setSensitivity(name) {
    this.sens = SENSITIVITY[name] || SENSITIVITY.medium;
  }

  reset() {
    this.rim = null;
    this.rimLocked = false;
    this.rimManual = false;
    this.rimSource = null;
    this._rimCand = null;
    this._rimHits = 0;
    this._rimMiss = 0;
    this._pending = [];
    this._offer = null;
    this._offerHits = 0;
    this._offerMiss = 0;
    this._moveCand = null;
    this._moveHits = 0;
    this.frame = 0;
    this.tracks = [];
    this._nextId = 1;
    this.shot = null;
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
  setRim(rim, { manual = false, locked = true, source = null } = {}) {
    if (!rim) return this.clearRim();
    this.rim = { ...rim };
    this.rimLocked = locked;
    this.rimManual = manual;
    this.rimSource = manual ? 'manual' : source || this.rimSource || 'color';
    this._offerMiss = 0;
    this._rimMiss = 0;
    this._rimCand = locked ? { ...rim } : null;
    this._rimHits = locked ? RIM_HITS_TO_LOCK : 0;
  }

  clearRim() {
    this.rim = null;
    this.rimLocked = false;
    this.rimManual = false;
    this.rimSource = null;
    this._offer = null;
    this._offerHits = 0;
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
    const events = this._pending.splice(0);
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
      const isFg = d > thr ? 1 : 0;
      // Там, где сейчас движущийся объект, фон учится в 7 раз медленнее: иначе мяч, зависший
      // на верхней точке отскока, «впечатывается» в фон и оставляет неподвижный призрак.
      const ab = isFg ? a * 0.15 : a;
      bg[k] += dr * ab; bg[k + 1] += dg * ab; bg[k + 2] += db * ab;
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
      shots: this.shots,
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

    const similar = _similar;

    if (!this.rimLocked) {
      if (best && similar(best, this._rimCand)) this._rimHits++;
      else this._rimHits = best ? 1 : 0;
      this._rimCand = best;
      if (this.colorAutoLock && this._rimHits >= RIM_HITS_TO_LOCK) {
        this.rim = { ...best };
        this.rimLocked = true;
        this.rimSource = 'color';
        this._rimMiss = 0;
        events.push({ type: 'rim-found', rim: { ...best }, source: 'color' });
      }
    } else {
      if (this.rimSource !== 'color') {
        // Кольцо найдено по форме: цвет только подправляет положение, но не «теряет» кольцо.
        if (best && _similar(best, this.rim)) this._rimMiss = 0;
        return;
      }
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

  /**
   * Результат поиска кольца по форме (из фонового потока), в координатах кадра обработки.
   * cand = {cx, cy, w, h} или null, если кольцо на кадре не найдено.
   */
  offerRim(cand) {
    if (this.rimManual) return;
    if (!cand) {
      this._offerHits = 0;
      if (this.rimLocked && this.rimSource === 'shape' && ++this._offerMiss > 12) {
        this.clearRim();
        this._pending.push({ type: 'rim-lost' });
      }
      return;
    }
    if (!this.rimLocked) {
      this._offerHits = _similar(cand, this._offer) ? this._offerHits + 1 : 1;
      this._offer = { ...cand };
      if (this._offerHits >= 2) {
        this.setRim(cand, { source: 'shape' });
        this._pending.push({ type: 'rim-found', rim: { ...cand }, source: 'shape' });
      }
      return;
    }
    if (_similar(cand, this.rim)) {
      if (this.rimSource === 'shape') {
        const k = 0.3;
        for (const key of ['cx', 'cy', 'w', 'h']) this.rim[key] += (cand[key] - this.rim[key]) * k;
      }
      this._offerMiss = 0;
      this._moveHits = 0;
      return;
    }
    // Уверенно найдено кольцо в другом месте (камеру сдвинули) — переезжаем после 3 подтверждений.
    this._moveHits = _similar(cand, this._moveCand) ? this._moveHits + 1 : 1;
    this._moveCand = { ...cand };
    if (this._moveHits >= 3) {
      this._moveHits = 0;
      this.setRim(cand, { source: 'shape' });
      this.shot = null;
      this._pending.push({ type: 'rim-found', rim: { ...cand }, source: 'shape', moved: true });
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
    const R = this.rimLocked ? this.rim : null;
    for (const tr of tracks) {
      const L = tr.pts[tr.pts.length - 1];
      const dtt = (t - L.t) / 1000;
      tr.px = L.x + tr.vx * dtt;
      tr.py = L.y + tr.vy * dtt + 0.5 * g * dtt * dtt;
      const sp = Math.hypot(tr.vx, tr.vy);
      const d = D || tr.d;
      // Пока скорость неизвестна (новый трек) или мяч у кольца — окно шире; у «зрелого» трека в полёте —
      // узкое вокруг прогноза, иначе при нескольких мячах в воздухе треки перескакивают с мяча на мяч.
      const nearRim = R && Math.hypot(L.x - R.cx, L.y - R.cy) < R.w * 1.6; // у кольца мяч отскакивает и резко меняет направление
      tr.gate = tr.pts.length < 3 || nearRim ? Math.max(2.5 * d, 1.5 * d + 0.6 * sp * dtt) : Math.max(1.2 * d, 0.8 * d + 0.35 * sp * dtt);
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

  // Несколько бросков могут идти одновременно (групповая тренировка): каждый привязан к своему мячу.
  get shot() {
    return this.shots.length ? this.shots[this.shots.length - 1] : null;
  }

  set shot(v) {
    if (v === null) {
      this.shots = [];
      this._dead = [];
    }
  }

  _updateShot(t, events) {
    const R = this.rim;
    const cx = R.cx, cy = R.cy, W = R.w, D = W * BALL_TO_RIM;
    this._dead = this._dead.filter((z) => z.until > t);
    // Сначала ведём начатые броски — они могут узнать «свой» мяч, вернувшийся в кадр, раньше,
    // чем он будет принят за новый бросок.
    for (const s of this.shots.slice()) this._stepShot(s, t, events);

    // Новые броски: мяч поднялся выше кольца рядом с ним.
    if (t >= this.suspendUntil) {
      for (const tr of this.tracks) {
        if (tr.used || tr.pts.length < 3 || tr.lastSeen !== t) continue;
        const p = tr.pts[tr.pts.length - 1];
        if (!(p.y < cy - 0.25 * D && Math.abs(p.x - cx) < 3 * W && tr.travel > 1.5 * D)) continue;
        // Мяч в полёте над кольцом не стоит на месте; неподвижное пятно — «призрак» в модели фона
        // (мяч завис на верхней точке отскока и частично впечатался в фон).
        const back = tr.pts[Math.max(0, tr.pts.length - 4)];
        if (Math.hypot(p.x - back.x, p.y - back.y) < 0.5 * D) continue;
        // Осколок уже отслеживаемого мяча (мяч разрезан ободом/сеткой) — не новый бросок.
        if (this.shots.some((o) => Math.hypot(o.last.x - p.x, o.last.y - p.y) < 1.5 * D)) continue;
        // Тот же мяч сразу после решения (отскок, повторный захват) — не новый бросок.
        if (this._dead.some((z) => Math.hypot(z.x - p.x, z.y - p.y) < z.r)) continue;
        tr.used = true;
        this.shots.push({ track: tr, start: t, near: false, crossIn: null, rimTouch: false, last: p, lastSeen: t, netPeak: 0, pts: [p] });
      }
    }
  }

  /** Мяч ушёл за верхний край кадра на высокой дуге — вернётся сверху. */
  _exitedTop(s) {
    return s.last.y < this.h * 0.08 && (s.track.vy || 0) < 0;
  }

  _stepShot(s, t, events) {
    const R = this.rim;
    const cx = R.cx, cy = R.cy, W = R.w, hw = W / 2, D = W * BALL_TO_RIM;
    const decide = (type) => {
      this.shots.splice(this.shots.indexOf(s), 1);
      this._dead.push({ x: s.last.x, y: s.last.y, r: 2 * W, until: t + 900 });
      if (type !== 'cancel') events.push({ type, t, pts: s.pts });
    };

    // Если мяч потерян (перекрыт кольцом/щитом), подхватываем новый трек рядом с последней позицией.
    // Ищем только там, где по физике должен оказаться потерянный мяч (скорость + гравитация):
    // в групповой тренировке рядом летают чужие мячи, и «ближайший» трек часто не тот.
    const exited = this._exitedTop(s);
    if ((!this.tracks.includes(s.track) || s.track.lastSeen !== t) && t - s.lastSeen < (exited ? 2500 : 800)) {
      const gap = (t - s.lastSeen) / 1000;
      const g = 9.8 * (W / 0.457);
      const vx = s.track.vx || 0, vy = s.track.vy || 0;
      const px = s.last.x + vx * gap, py = s.last.y + vy * gap + 0.5 * g * gap * gap;
      const gate = 1.5 * D + 0.5 * Math.hypot(vx, vy) * gap + 0.5 * g * gap * gap;
      let bestO = null, bestD = gate;
      for (const o of this.tracks) {
        if (o === s.track || o.used || o.lastSeen !== t || o.pts.length > 5) continue;
        const p = o.pts[o.pts.length - 1];
        if (s.crossIn && p.y < cy - 0.5 * D) continue; // мяч уже прошёл обод вниз — выше кольца его быть не может
        if (exited) {
          // вернулся сверху: трек начался у верхнего края, по горизонтали — где и должен быть
          const first = o.pts[0];
          const dx = Math.abs(first.x - (s.last.x + vx * ((first.t - s.lastSeen) / 1000)));
          if (first.y < this.h * 0.15 && dx < 1.5 * W && dx < bestD) {
            bestD = dx;
            bestO = o;
          }
          continue;
        }
        // Падающий мяч не может вдруг полететь вверх вдали от кольца (разворот — только отскок от обода/щита).
        if (vy > 0 && (o.vy || 0) < -Math.abs(vy) * 0.3 && Math.hypot(p.x - cx, p.y - cy) > 1.6 * W && p.y < this.h * 0.8) continue;
        const d = Math.hypot(p.x - px, p.y - py);
        if (d < bestD) {
          bestD = d;
          bestO = o;
        }
      }
      if (bestO) {
        s.track = bestO;
        bestO.used = true;
        s.adoptedAt = t;
        if (exited) s.last = bestO.pts[0]; // не считать возврат из-за кадра «скачком»
      }
    }

    const tr = s.track;
    if (tr.lastSeen === t) {
      const p = tr.pts[tr.pts.length - 1];
      const q = s.last;
      // Мяч не может полсекунды стоять на месте: даже на верхней точке отскока гравитация сдвигает его
      // на ~0.5 диаметра. Неподвижное пятно — призрак в фоне; такие точки не считаем наблюдением мяча.
      let spread = 0, i0 = tr.pts.length - 1;
      while (i0 > 0 && t - tr.pts[i0 - 1].t <= 500) i0--;
      if (t - tr.pts[i0].t >= 400) {
        for (let i = i0; i < tr.pts.length; i++) spread = Math.max(spread, Math.hypot(tr.pts[i].x - p.x, tr.pts[i].y - p.y));
        if (spread < 0.3 * D) return this._timeouts(s, t, decide);
      }
      // Точка, физически недостижимая для этого мяча, — это другой объект: не учитываем.
      const gapS = Math.max(0.02, (t - s.lastSeen) / 1000 || 0.033);
      const reach = 2 * D + Math.hypot(tr.vx, tr.vy) * gapS * 1.5 + 9.8 * (W / 0.457) * gapS * gapS;
      if (s.pts.length > 1 && s.adoptedAt !== t && Math.hypot(p.x - q.x, p.y - q.y) > reach) {
        s.track = { lastSeen: -1, vx: tr.vx, vy: tr.vy, pts: [q] };
        return this._timeouts(s, t, decide);
      }
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

    return this._timeouts(s, t, decide);
  }

  _timeouts(s, t, decide) {
    const R = this.rim;
    const cx = R.cx, cy = R.cy, W = R.w, hw = W / 2;
    if (s.near || s.crossIn) s.netPeak = Math.max(s.netPeak, this.netScore);

    const lostFor = t - s.lastSeen;
    if (s.crossIn) {
      // Мяч прошёл обод вниз и пропал в сетке / не вернулся — попадание.
      if (lostFor > 450 || t - s.crossIn.t > 900) return decide('make');
    } else if (lostFor > (this._exitedTop(s) ? 2500 : 900)) {
      const p = s.last;
      const descending = s.track.vy > 0;
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
