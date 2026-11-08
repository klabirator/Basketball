// Громкие синтезированные звуки (без файлов): компрессор + усиление + мягкое ограничение,
// чтобы звук был слышен на площадке из динамика телефона.

export const SOUND_PACKS = {
  classic: 'Классика — свист сетки и звонок / сирена',
  arcade: 'Аркада — 8-бит',
  stadium: 'Стадион — трибуны и горн',
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = 1;
    this.pack = 'classic';
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 6;
      comp.ratio.value = 10;
      comp.attack.value = 0.002;
      comp.release.value = 0.15;
      const makeup = ctx.createGain();
      makeup.gain.value = 2.2;
      const clip = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
      }
      clip.curve = curve;
      this.master.connect(comp);
      comp.connect(makeup);
      makeup.connect(clip);
      clip.connect(ctx.destination);
      this._noise = this._makeNoise();
    }
    this.master.gain.value = this.volume;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  _makeNoise() {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _env(gainNode, t0, attack, hold, release, peak) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + attack);
    g.setValueAtTime(peak, t0 + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
  }

  tone(freq, start, dur, { type = 'sine', gain = 0.5, to = null, attack = 0.005, release = null, detune = 0 } = {}) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    o.detune.value = detune;
    const g = ctx.createGain();
    const rel = release ?? Math.min(0.25, dur * 0.6);
    this._env(g, t0, attack, Math.max(0, dur - attack - rel), rel, gain);
    o.connect(g);
    g.connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  noise(start, dur, { type = 'bandpass', freq = 2000, to = null, q = 1, gain = 0.5, attack = 0.01, release = null } = {}) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    const rel = release ?? dur * 0.6;
    this._env(g, t0, attack, Math.max(0, dur - attack - rel), rel, gain);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }

  play(name) {
    if (!this.ctx || this.volume <= 0) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const fn = this[`_${this.pack}_${name}`] || this[`_${name}`];
    if (fn) fn.call(this);
  }

  // ── Классика ──
  _classic_make() {
    this.noise(0, 0.35, { freq: 2500, to: 7000, q: 0.8, gain: 0.7, attack: 0.02 }); // «шшух» сетки
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
      this.tone(f, 0.12 + i * 0.07, 0.7, { type: 'triangle', gain: 0.45 });
      this.tone(f * 2, 0.12 + i * 0.07, 0.4, { type: 'sine', gain: 0.12 });
    });
  }
  _classic_miss() {
    this.tone(150, 0, 0.75, { type: 'square', gain: 0.45, release: 0.08 });
    this.tone(156, 0, 0.75, { type: 'sawtooth', gain: 0.35, release: 0.08 });
    this.tone(75, 0, 0.75, { type: 'square', gain: 0.3, release: 0.08 });
  }

  // ── Аркада ──
  _arcade_make() {
    [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, i * 0.065, 0.09, { type: 'square', gain: 0.4, release: 0.02 }));
    this.tone(1568, 0.33, 0.35, { type: 'square', gain: 0.4 });
  }
  _arcade_miss() {
    this.tone(392, 0, 0.28, { type: 'sawtooth', gain: 0.5, to: 300 });
    this.tone(300, 0.3, 0.28, { type: 'sawtooth', gain: 0.5, to: 220 });
    this.tone(220, 0.6, 0.6, { type: 'sawtooth', gain: 0.55, to: 90 });
  }

  // ── Стадион ──
  _stadium_make() {
    this.noise(0, 1.6, { freq: 1100, q: 0.6, gain: 0.8, attack: 0.15, release: 0.9 });
    this.noise(0.05, 1.3, { freq: 2600, q: 1.2, gain: 0.35, attack: 0.2 });
    this.tone(233, 0, 0.6, { type: 'sawtooth', gain: 0.35 });
    this.tone(349, 0, 0.6, { type: 'sawtooth', gain: 0.35 });
    this.tone(466, 0, 0.6, { type: 'sawtooth', gain: 0.25 });
  }
  _stadium_miss() {
    this.noise(0, 1.1, { freq: 450, to: 300, q: 2, gain: 0.8, attack: 0.1 });
    this.tone(260, 0, 1.0, { type: 'sawtooth', gain: 0.3, to: 130 });
    this.tone(262, 0, 1.0, { type: 'triangle', gain: 0.35, to: 128 });
  }

  // ── Общие сигналы ──
  _streak() {
    [523, 659, 784].forEach((f, i) => this.tone(f, 0.9 + i * 0.11, 0.12, { type: 'triangle', gain: 0.4, release: 0.03 }));
    this.tone(1046, 0.9 + 0.33, 0.55, { type: 'triangle', gain: 0.45 });
    this.tone(1318, 0.9 + 0.33, 0.55, { type: 'sine', gain: 0.25 });
  }
  _ready() {
    this.tone(880, 0, 0.12, { type: 'sine', gain: 0.5 });
    this.tone(1320, 0.15, 0.2, { type: 'sine', gain: 0.5 });
  }
  _tick() {
    this.tone(700, 0, 0.12, { type: 'square', gain: 0.3 });
  }
  _go() {
    this.tone(1400, 0, 0.4, { type: 'square', gain: 0.35 });
  }
  _warn() {
    this.tone(500, 0, 0.18, { type: 'triangle', gain: 0.4 });
    this.tone(400, 0.22, 0.25, { type: 'triangle', gain: 0.4 });
  }
  _end() {
    [784, 659, 523].forEach((f, i) => this.tone(f, i * 0.15, 0.18, { type: 'triangle', gain: 0.45 }));
    [523, 659, 784, 1046].forEach((f) => this.tone(f, 0.5, 0.9, { type: 'triangle', gain: 0.25 }));
  }
  _undo() {
    this.tone(600, 0, 0.1, { type: 'sine', gain: 0.35, to: 400 });
  }
}
