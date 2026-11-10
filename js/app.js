import { ShotDetector } from './detector.js';
import { RimLocator, isRimColor } from './rimfinder.js';
import { Camera } from './camera.js';
import { Sound, SOUND_PACKS } from './audio.js';
import { Voice, Commands } from './voice.js';
import {
  loadSettings, saveSettings, loadSessions, saveSession, deleteSession, clearSessions,
  importSessions, sessionsToCSV, sessionStats,
} from './storage.js';
import { renderHistory, renderSessionDetail, aggregate, fmtDur, shotsWord, esc } from './history.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

export const PROGRAMS = {
  mid5: { name: '5 точек — средняя', spots: ['Левый угол', 'Левый фланг 45°', 'Центр', 'Правый фланг 45°', 'Правый угол'] },
  three5: { name: '5 точек — трёхочковые', spots: ['Левый угол за дугой', 'Левый фланг за дугой', 'Центр за дугой', 'Правый фланг за дугой', 'Правый угол за дугой'] },
  ft: { name: 'Штрафные', spots: ['Штрафная линия'] },
  close: { name: 'Ближние у щита', spots: ['Слева от кольца', 'Под кольцом', 'Справа от кольца'] },
  around: { name: 'Вокруг света (7 точек)', spots: ['Левый угол', 'Левая «короткая»', 'Левый фланг', 'Штрафная', 'Правый фланг', 'Правая «короткая»', 'Правый угол'] },
};
const MODE_LABEL = { free: 'Свободный', shots: 'На количество', time: 'На время', spots: 'По точкам' };
const STREAKS = new Set([3, 5, 7, 10, 15, 20, 25, 30, 40, 50]);
const START_DELAY = 5000; // время дойти до точки броска после нахождения кольца
const TRANSITION_MS = 8000;

// ───────────────────────────── Состояние ─────────────────────────────
const settings = loadSettings();
const sound = new Sound();
sound.pack = settings.soundPack;
sound.setVolume(settings.volume);
const voice = new Voice();
const commands = new Commands(onVoiceCommand);
// Цвет лишь предлагает кольцо; фиксируется оно после проверки формы (сетка + щит) в фоновом потоке.
const detector = new ShotDetector({ sensitivity: settings.sensitivity, colorAutoLock: false });
const video = $('#video');
const camera = new Camera(video);
const view = $('#view');
const vctx = view.getContext('2d');
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

let T = null; // текущая тренировка
let running = false;
let wakeLock = null;
let historyView = 'sessions';
let lastSummaryId = null;
let lastVideoFile = null; // для «Ещё раз» после проверки на видео
let videoUrl = null;
let lastVideoT = -1;
let pendingRim = null; // кольцо, найденное предварительным просмотром ролика (доли кадра)
const SPEEDS = [0.5, 1, 2];

const Z = { total: 1, fx: 0.5, fy: 0.5 }; // фокус — в «базовых» нормированных координатах (при аппаратном зуме 1)
const V = { vw: 0, vh: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, pw: 0, ph: 0, hw: 1 };
let rimBase = null; // кольцо в базовых координатах {x, y, w, h}
let lastRes = null;
let procAvg = 10;

// ── Поиск кольца по форме: кадр ~800 px, усреднённый во времени, анализируется в фоновом потоке ──
const hiCanvas = document.createElement('canvas');
const hctx = hiCanvas.getContext('2d', { willReadFrequently: true });
const HI = { w: 0, h: 0, acc: null, wacc: null, n: 0, busy: false, id: 0, lastSent: -1e9, sentAt: 0, searchStart: 0 };
const mainLocator = new RimLocator(); // для касания «◎» и на случай, если фоновый поток недоступен
let rimWorker = null;
try {
  rimWorker = new Worker(new URL('./rimworker.js', import.meta.url), { type: 'module' });
  rimWorker.onmessage = (e) => onRimResult(e.data);
  rimWorker.onerror = () => {
    rimWorker = null;
    HI.busy = false;
  };
} catch {
  rimWorker = null;
}

function resetRimSearch() {
  HI.id++;
  HI.n = 0;
  HI.busy = false;
  HI.lastSent = -1e9;
}

function rimSearchStep() {
  if (detector.rimManual || !V.pw) return;
  if (frameNo % 3 === 0) {
    const c = V.crop;
    const k = Math.min(1, 800 / Math.max(c.w, c.h));
    const w = Math.max(32, Math.round(c.w * k)), h = Math.max(32, Math.round(c.h * k));
    if (w !== HI.w || h !== HI.h) {
      HI.w = w;
      HI.h = h;
      hiCanvas.width = w;
      hiCanvas.height = h;
      HI.acc = new Float32Array(w * h);
      HI.wacc = new Float32Array(w * h);
      HI.n = 0;
    }
    hctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, w, h);
    const d = hctx.getImageData(0, 0, w, h).data, acc = HI.acc, wacc = HI.wacc;
    const a = HI.n === 0 ? 1 : 0.25; // усреднение убирает движущихся людей и мяч
    for (let i = 0, j = 0; i < acc.length; i++, j += 4) {
      const g = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      acc[i] += (g - acc[i]) * a;
      wacc[i] += ((isRimColor(d[j], d[j + 1], d[j + 2]) ? 1 : 0) - wacc[i]) * a;
    }
    HI.n++;
  }
  const interval = detector.rimLocked ? 90 : 18;
  if (HI.busy && rimWorker && performance.now() - HI.sentAt > 4000) {
    rimWorker.terminate(); // фоновый поток не отвечает (старый WebView) — ищем в основном потоке
    rimWorker = null;
    HI.busy = false;
  }
  if (HI.busy || HI.n < 3 || frameNo - HI.lastSent < interval) return;
  HI.lastSent = frameNo;
  const gray = Uint8Array.from(HI.acc);
  const warm = warmMask();
  const s = HI.w / V.pw;
  const cc = detector._rimCand;
  const colorCand = cc ? { cx: cc.cx * s, cy: cc.cy * s, w: cc.w * s, h: cc.h * s } : null;
  const msg = { id: HI.id, gray, warm, w: HI.w, h: HI.h, colorCand };
  if (rimWorker) {
    HI.busy = true;
    HI.sentAt = performance.now();
    rimWorker.postMessage(msg, [gray.buffer, warm.buffer]);
  } else {
    onRimResult({ id: msg.id, rim: mainLocator.locate(gray, msg.w, msg.h, colorCand, warm) });
  }
}

function warmMask() {
  const m = new Uint8Array(HI.wacc.length);
  for (let i = 0; i < m.length; i++) m[i] = HI.wacc[i] > 0.5 ? 1 : 0;
  return m;
}

function onRimResult({ id, rim }) {
  HI.busy = false;
  if (id !== HI.id || !running || detector.rimManual) return; // кадр с тех пор изменился (зум, поворот)
  const s = V.pw / HI.w;
  detector.offerRim(rim ? { cx: rim.cx * s, cy: rim.cy * s, w: rim.w * s, h: Math.max(2, rim.h * s), sure: !!rim.sure } : null);
}

// ───────────────────────────── Навигация ─────────────────────────────
function go(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  if (name === 'home') renderHome();
  if (name === 'history') showHistory();
  if (name === 'settings') fillSettings();
  window.scrollTo(0, 0);
}
$$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

function toast(text, ms = 2200) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function modal(html, onMount) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
  onMount?.($('#modal-body'));
}
function closeModal() {
  $('#modal').classList.add('hidden');
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

// ───────────────────────────── Главная ─────────────────────────────
function renderHome() {
  const sessions = loadSessions();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = aggregate(sessions, today.getTime());
  const w = aggregate(sessions, Date.now() - 7 * 864e5);
  const all = aggregate(sessions);
  $('#home-stats').innerHTML = `
    <div class="stat"><b>${t.attempts ? `${t.makes}/${t.attempts}` : '—'}</b><small>Сегодня${t.pct != null ? ` · ${t.pct}%` : ''}</small></div>
    <div class="stat"><b>${w.pct != null ? w.pct + '%' : '—'}</b><small>Точность 7 дн.</small></div>
    <div class="stat"><b>${all.attempts}</b><small>Всего бросков</small></div>`;
  $$('.mode').forEach((b) => {
    const on = b.dataset.mode === settings.lastMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  renderModeOpts();
}

function chips(name, values, current, suffix = '') {
  const custom = !values.includes(Number(current));
  return `<div class="chips" data-opt="${name}">${values
    .map((v) => `<button class="chip ${Number(current) === v ? 'on' : ''}" data-v="${v}">${v}${suffix}</button>`)
    .join('')}<span class="chip ${custom ? 'on' : ''}"><input type="number" min="1" max="999" inputmode="numeric" placeholder="своё" value="${custom ? current : ''}"></span></div>`;
}

function renderModeOpts() {
  const o = settings.modeOpts;
  const el = $('#mode-opts');
  const m = settings.lastMode;
  if (m === 'free') el.innerHTML = `<p>Считаем, пока не скажете «закончить» или не нажмёте ■. Звук и голос подскажут счёт.</p>`;
  if (m === 'shots') el.innerHTML = `<div class="opt-title">Сколько бросков</div>${chips('shots', [25, 50, 100, 200], o.shots)}`;
  if (m === 'time') el.innerHTML = `<div class="opt-title">Длительность, минут</div>${chips('minutes', [5, 10, 15, 30], o.minutes)}`;
  if (m === 'spots') {
    el.innerHTML = `<div class="opt-title">Программа</div><div class="chips" data-prog>${Object.entries(PROGRAMS)
      .map(([k, p]) => `<button class="chip ${o.program === k ? 'on' : ''}" data-v="${k}">${esc(p.name)}</button>`)
      .join('')}</div>
      <div class="opt-title">Бросков с каждой точки</div>${chips('perSpot', [5, 10, 15, 20], o.perSpot)}
      <p>После серии голос назовёт следующую точку и даст ${TRANSITION_MS / 1000} секунд на переход.</p>`;
  }
  el.querySelectorAll('[data-opt]').forEach((group) => {
    const key = group.dataset.opt;
    group.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        o[key] = Number(b.dataset.v);
        saveSettings(settings);
        renderModeOpts();
      }),
    );
    const inp = group.querySelector('input');
    inp.addEventListener('change', () => {
      const v = Math.round(Number(inp.value));
      if (v > 0) {
        o[key] = v;
        saveSettings(settings);
        renderModeOpts();
      }
    });
  });
  el.querySelectorAll('[data-prog] button').forEach((b) =>
    b.addEventListener('click', () => {
      o.program = b.dataset.v;
      saveSettings(settings);
      renderModeOpts();
    }),
  );
}

$$('.mode').forEach((b) =>
  b.addEventListener('click', () => {
    settings.lastMode = b.dataset.mode;
    saveSettings(settings);
    renderHome();
  }),
);

$('#btn-start').addEventListener('click', () => {
  sound.unlock();
  if (!settings.seenHelp) {
    modal(
      `<h2>Перед первой тренировкой</h2>
       <ol class="help">
         <li>Поставьте телефон <b>сбоку под углом ~45°</b> к щиту, на штатив или опору.</li>
         <li>Кольцо — в верхней половине кадра, над ним видно 2–3 м для дуги мяча.</li>
         <li>Кольцо найдётся само. После сигнала у вас есть 5 секунд, чтобы встать на точку.</li>
         <li>Дальше экран трогать не нужно: звук, голос и крупные цифры покажут результат.</li>
       </ol>
       <button class="btn primary big" id="help-ok" style="width:100%">Понятно — начать</button>`,
      (b) =>
        b.querySelector('#help-ok').addEventListener('click', () => {
          settings.seenHelp = true;
          saveSettings(settings);
          closeModal();
          startTraining();
        }),
    );
    return;
  }
  startTraining();
});

// ───────────────────────────── Тренировка ─────────────────────────────
function modeLabel() {
  const o = settings.modeOpts;
  switch (settings.lastMode) {
    case 'shots': return `${o.shots} бросков`;
    case 'time': return `${o.minutes} мин`;
    case 'spots': return `${PROGRAMS[o.program].name} × ${o.perSpot}`;
    default: return MODE_LABEL.free;
  }
}

async function startTraining(videoFile = null) {
  const o = settings.modeOpts;
  const mode = videoFile ? 'free' : settings.lastMode;
  T = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    mode,
    modeLabel: videoFile ? 'Проверка на видео' : modeLabel(),
    video: videoFile ? { name: videoFile.name } : null,
    events: [],
    target: mode === 'shots' ? o.shots : null,
    durationMs: mode === 'time' ? o.minutes * 60000 : null,
    spots: mode === 'spots' ? PROGRAMS[o.program].spots.slice() : null,
    perSpot: mode === 'spots' ? o.perSpot : null,
    startedAt: Date.now(),
    shots: [],
    activeMs: 0,
    lastTick: performance.now(),
    started: false,
    goAt: 0,
    paused: null,
    spotIdx: 0,
    spotShots: 0,
    transitionUntil: 0,
    streak: 0,
    warned: {},
    finished: false,
  };
  go('train');
  updateScore();
  $('#video-bar').classList.toggle('hidden', !videoFile);
  $('#b-pause').textContent = '❚❚';
  voice.enabled = settings.voiceMode !== 'off';

  if (videoFile) {
    lastVideoFile = videoFile;
    setStatus('Открываю видео…');
    showCenter('Открываю видео…');
    try {
      await openVideo(videoFile);
    } catch (e) {
      showCenter(`Не удалось открыть видео.<small>${esc(e?.message || 'Формат не поддерживается этим браузером. Попробуйте MP4 (H.264) или WebM.')}</small>`);
      setStatus('Ошибка видео', 'bad');
      setTimeout(() => {
        if (T && !T.shots.length) {
          closeVideo();
          T = null;
          go('home');
        }
      }, 5000);
      return;
    }
  } else try {
    setStatus('Запуск камеры…');
    showCenter('Запуск камеры…');
    voice.say('Наведите камеру на кольцо', { interrupt: true });
    await camera.start({ resolution: settings.resolution });
  } catch (e) {
    const denied = e?.name === 'NotAllowedError';
    showCenter(
      denied
        ? 'Нет доступа к камере.<small>Разрешите камеру для этого сайта в настройках браузера и попробуйте снова.</small>'
        : `Камера недоступна.<small>${esc(e?.message || e)}</small>`,
    );
    setStatus('Камера недоступна', 'bad');
    setTimeout(() => {
      if (T && !T.shots.length) {
        T = null;
        go('home');
      }
    }, 5000);
    return;
  }

  detector.reset();
  resetRimSearch();
  HI.searchStart = performance.now();
  detector.setSensitivity(settings.sensitivity);
  detector.counting = false;
  rimBase = null;
  Z.total = 1;
  Z.fx = 0.5;
  Z.fy = 0.5;
  V.vw = 0;
  lastVideoT = -1;
  pendingRim = null;
  if (videoFile) {
    pendingRim = await prescanRim().catch(() => null);
    if (!T || T.finished) return;
    await video.play().catch(() => {});
    $('#v-play').textContent = '❚❚';
  }
  if (camera.hwCaps) await camera.setHwZoom(camera.hwCaps.min <= 1 ? 1 : camera.hwCaps.min);
  setStatus('Ищу кольцо…', 'warn');
  showCenter('Ищу кольцо…<small>Кольцо должно быть в кадре целиком. Если не находится — нажмите ◎ и коснитесь его.</small>');
  requestWakeLock();
  if (settings.voiceCommands) commands.start();
  running = true;
  resizeView();
  scheduleFrame();
  bumpControls();
}

async function openVideo(file) {
  camera.stop();
  closeVideo();
  videoUrl = URL.createObjectURL(file);
  $('#video-bar').classList.remove('hidden');
  video.srcObject = null;
  video.muted = true;
  video.loop = false;
  video.src = videoUrl;
  await new Promise((res, rej) => {
    const ok = () => (video.videoWidth ? res() : rej(new Error('В файле нет видеодорожки.')));
    video.addEventListener('loadedmetadata', ok, { once: true });
    video.addEventListener('error', () => rej(null), { once: true });
  });
  video.playbackRate = settings.videoSpeed || 1;
  $('#v-speed').textContent = `${video.playbackRate}×`;
}

const seekTo = (t) =>
  new Promise((res) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      res();
    };
    video.addEventListener('seeked', done);
    setTimeout(done, 2500);
    video.currentTime = t;
  });

/**
 * Предварительный просмотр ролика: по десятку кадров из разных мест находим кольцо ещё до воспроизведения
 * (люди и мяч в разных кадрах в разных местах — усреднение их убирает), чтобы считать броски с первой секунды.
 */
async function prescanRim() {
  const dur = video.duration;
  if (!isFinite(dur) || dur < 1 || !video.videoWidth) return null;
  const k = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
  hiCanvas.width = w;
  hiCanvas.height = h;
  const n = Math.max(3, Math.min(12, Math.floor(dur / 0.4)));
  const sum = new Float32Array(w * h), wsum = new Float32Array(w * h);
  for (let i = 0; i < n; i++) {
    await seekTo((dur * (i + 0.5)) / n);
    hctx.drawImage(video, 0, 0, w, h);
    const d = hctx.getImageData(0, 0, w, h).data;
    for (let p = 0, j = 0; p < sum.length; p++, j += 4) {
      sum[p] += (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      if (isRimColor(d[j], d[j + 1], d[j + 2])) wsum[p]++;
    }
    showCenter(`Ищу кольцо в ролике… ${Math.round(((i + 1) / n) * 100)}%`);
  }
  const gray = new Uint8Array(w * h), warm = new Uint8Array(w * h);
  for (let p = 0; p < gray.length; p++) {
    gray[p] = sum[p] / n;
    warm[p] = wsum[p] > n / 2 ? 1 : 0;
  }
  HI.w = 0; // размеры холста изменены — буфер живого поиска пересоздастся
  // Фиксируем только при уверенном результате; иначе кольцо найдётся по ходу воспроизведения.
  const rim = mainLocator.locate(gray, w, h, null, warm);
  await seekTo(0);
  return rim ? { x: rim.cx / w, y: rim.cy / h, w: rim.w / w, h: Math.max(2, rim.h) / h, sure: !!rim.sure } : null;
}

function closeVideo() {
  if (videoUrl) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(videoUrl);
    videoUrl = null;
  }
  $('#video-bar').classList.add('hidden');
}

function scheduleFrame() {
  if (!running) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame(onFrame);
}

let frameNo = 0;
function onFrame(_ts, meta) {
  if (!running) return;
  scheduleFrame();
  // В режиме видео время берётся из таймкода ролика: скорость и перемотка не искажают физику полёта.
  let vt = null;
  if (T?.video) {
    vt = (meta?.mediaTime ?? video.currentTime) * 1000;
    if (vt === lastVideoT) return;
    if (vt < lastVideoT) detector.resetTime();
    lastVideoT = vt;
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  if (vw !== V.vw || vh !== V.vh) {
    V.vw = vw;
    V.vh = vh;
    applyView();
    if (pendingRim && !detector.rimLocked) {
      rimBase = pendingRim;
      pendingRim = null;
      detector.setRim(baseToProc(rimBase), { source: 'shape', sure: !!rimBase.sure });
      handleEvent({ type: 'rim-found' }, performance.now());
    }
  }
  const now = performance.now();
  frameNo++;
  const skip = procAvg > 30 && frameNo % 2 === 1;
  if (!skip) {
    const t0 = performance.now();
    const c = V.crop;
    pctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, V.pw, V.ph);
    const img = pctx.getImageData(0, 0, V.pw, V.ph);
    detector.counting = isCounting(now);
    lastRes = detector.process(img.data, V.pw, V.ph, vt ?? now);
    procAvg = procAvg * 0.9 + (performance.now() - t0) * 0.1;
    if (detector.rimLocked && detector.rim) rimBase = procToBase(detector.rim);
    for (const e of lastRes.events) handleEvent(e, now);
    rimSearchStep();
  }
  draw();
}

function isCounting(now) {
  return !!T && T.started && !T.paused && !T.finished && now >= T.goAt && detector.rimLocked;
}

// ── Геометрия: базовые координаты ↔ видео ↔ кадр анализа ──
function applyView() {
  if (!V.vw) return;
  const hw = camera.hwCaps && settings.hwZoom ? camera.hw : 1;
  V.hw = hw;
  const digital = Math.max(1, Z.total / hw);
  const cw = V.vw / digital, ch = V.vh / digital;
  const cxn = 0.5 + (Z.fx - 0.5) * hw, cyn = 0.5 + (Z.fy - 0.5) * hw;
  const x = Math.min(V.vw - cw, Math.max(0, cxn * V.vw - cw / 2));
  const y = Math.min(V.vh - ch, Math.max(0, cyn * V.vh - ch / 2));
  V.crop = { x, y, w: cw, h: ch };
  const long = Number(settings.procSize) || 400;
  const k = long / Math.max(cw, ch);
  V.pw = Math.max(16, Math.round(cw * k));
  V.ph = Math.max(16, Math.round(ch * k));
  proc.width = V.pw;
  proc.height = V.ph;
  detector.resetBackground();
  resetRimSearch();
  if (rimBase) {
    const r = baseToProc(rimBase);
    if (r.cx > 0 && r.cx < V.pw && r.cy > 0 && r.cy < V.ph) {
      const keep = { sure: detector.rimSure, cal: detector.rimCalibrated };
      detector.setRim(r, { manual: detector.rimManual, locked: true });
      detector.rimSure = keep.sure; // смена зума не меняет того, что мы знаем о ширине кольца
      detector.rimCalibrated = keep.cal;
    } else if (!detector.rimManual) {
      detector.clearRim();
      rimBase = null;
    }
  }
  detector.suspend(500);
  $('#z-val').textContent = `${Z.total.toFixed(1)}×`;
}

function baseToProc(b) {
  const hw = V.hw, c = V.crop, s = V.pw / c.w;
  const vx = (0.5 + (b.x - 0.5) * hw) * V.vw, vy = (0.5 + (b.y - 0.5) * hw) * V.vh;
  return { cx: (vx - c.x) * s, cy: (vy - c.y) * s, w: b.w * hw * V.vw * s, h: b.h * hw * V.vh * s };
}

function procToBase(r) {
  const hw = V.hw, c = V.crop, s = c.w / V.pw;
  const vx = c.x + r.cx * s, vy = c.y + r.cy * s;
  return { x: 0.5 + (vx / V.vw - 0.5) / hw, y: 0.5 + (vy / V.vh - 0.5) / hw, w: (r.w * s) / V.vw / hw, h: (r.h * s) / V.vh / hw };
}

function maxZoom() {
  const hwMax = camera.hwCaps && settings.hwZoom ? camera.hwCaps.max : 1;
  return Math.min(12, hwMax * 4);
}

async function setZoom(total, focus) {
  Z.total = Math.min(maxZoom(), Math.max(1, total));
  if (focus) {
    Z.fx = focus.x;
    Z.fy = focus.y;
  }
  if (Z.total <= 1.001) {
    Z.fx = 0.5;
    Z.fy = 0.5;
  }
  if (camera.hwCaps && settings.hwZoom) {
    const want = Math.min(camera.hwCaps.max, Math.max(camera.hwCaps.min, Z.total));
    if (Math.abs(want - camera.hw) > 0.01) await camera.setHwZoom(want);
  }
  applyView();
}

function autoZoom(force = false) {
  if (!rimBase) {
    if (force) setZoom(1);
    return;
  }
  // Кольцо ≈ 10% ширины кадра, расположено чуть ниже центра — сверху остаётся место для дуги.
  // Пока ширина кольца не подтверждена (щитом, мячом или вручную), она могла быть занижена поиском —
  // приближаем осторожнее, чтобы дуга мяча не вылетала из кадра.
  const wEff = detector.rimSure || detector.rimCalibrated ? rimBase.w : rimBase.w * 1.6;
  const target = Math.min(maxZoom(), Math.max(1, 0.1 / wEff));
  if (!force && target < Z.total * 1.15) return;
  setZoom(target, { x: rimBase.x, y: rimBase.y - 0.1 / target });
  if (!force) toast(`Приближение ${target.toFixed(1)}× к кольцу`);
}

// ── События детектора ──
function handleEvent(e, now) {
  if (!T || T.finished) return;
  if (e.type === 'rim-found') {
    hideCenter();
    sound.play('ready');
    setStatus('Кольцо найдено', 'ok');
    if (!T.started) {
      T.started = true;
      T.goAt = now + (T.video ? 0 : START_DELAY);
      T.lastTick = now;
      if (!T.video) voice.say(T.spots ? `Кольцо найдено. Первая точка: ${T.spots[0]}. Старт через 5 секунд` : 'Кольцо найдено. Старт через 5 секунд', { interrupt: true });
    } else {
      voice.say('Кольцо найдено', { interrupt: true });
    }
    if (settings.autoZoom) setTimeout(() => autoZoom(false), 50);
  } else if (e.type === 'camera-moving') {
    sound.play('warn');
    setStatus('Камера движется — закрепите телефон', 'bad');
    voice.say('Камера движется. Закрепите телефон', { interrupt: true });
    T.cameraMoved = (T.cameraMoved || 0) + 1;
  } else if (e.type === 'rim-lost') {
    sound.play('warn');
    setStatus('Кольцо потеряно — ищу…', 'warn');
    voice.say('Кольцо потеряно', { interrupt: true });
  } else if (e.type === 'make' || e.type === 'miss') {
    registerShot(e.type === 'make' ? 1 : 0, false);
  }
}

// ── Учёт бросков ──
function registerShot(r, manual) {
  if (!T || T.finished) return;
  const now = performance.now();
  tickTime(now);
  if (T.video) T.events.push({ vt: video.currentTime, r, m: manual });
  T.shots.push({ t: Math.round(T.activeMs), r, ...(T.spots ? { spot: T.spotIdx } : {}), ...(manual ? { m: 1 } : {}) });
  T.streak = r ? T.streak + 1 : 0;
  if (T.spots) T.spotShots++;
  feedback(r);
  updateScore();
  const st = sessionStats(T);

  let spoke = false;
  if (r && settings.streakAlerts && STREAKS.has(T.streak)) {
    sound.play('streak');
    voice.say(`Серия ${T.streak}!`, { delay: 1500 });
    spoke = true;
  }
  const vm = settings.voiceMode;
  if (!spoke) {
    if (vm === 'every') voice.say(`${st.makes} из ${st.attempts}`, { delay: 650 });
    else if ((vm === 'every5' && st.attempts % 5 === 0) || (vm === 'every10' && st.attempts % 10 === 0))
      voice.say(`${st.makes} из ${st.attempts}, ${st.pct} процентов`, { delay: 700 });
  }

  if (T.target && st.attempts >= T.target) {
    setTimeout(() => finishTraining(), 1300);
  } else if (T.spots && T.spotShots >= T.perSpot) {
    const v = st.bySpot[T.spotIdx] || { makes: 0, attempts: 0 };
    if (T.spotIdx >= T.spots.length - 1) {
      setTimeout(() => finishTraining(), 1300);
    } else {
      T.spotIdx++;
      T.spotShots = 0;
      T.paused = 'transition';
      T.transitionUntil = now + TRANSITION_MS;
      detector.suspend(TRANSITION_MS);
      voice.say(`Точка готова: ${v.makes} из ${v.attempts}. Переходите: ${T.spots[T.spotIdx]}`, { delay: 900, interrupt: true });
    }
  }
}

function undoShot() {
  if (!T || !T.shots.length) return;
  const last = T.shots.pop();
  if (T.spots && last.spot === T.spotIdx && T.spotShots > 0) T.spotShots--;
  let s = 0;
  for (const x of T.shots) s = x.r ? s + 1 : 0;
  T.streak = s;
  sound.play('undo');
  const st = sessionStats(T);
  voice.say(`Отменено. ${st.makes} из ${st.attempts}`, { interrupt: true });
  updateScore();
  toast('Последний бросок отменён');
}

function feedback(r) {
  sound.play(r ? 'make' : 'miss');
  if (settings.flash) {
    const f = $('#flash');
    f.className = `flash ${r ? 'make' : 'miss'}`;
    requestAnimationFrame(() => requestAnimationFrame(() => (f.className = 'flash')));
  }
  const lr = $('#last-result');
  lr.textContent = r ? 'ЕСТЬ!' : 'МИМО';
  lr.className = `last-result show ${r ? 'make' : 'miss'}`;
  clearTimeout(feedback._t);
  feedback._t = setTimeout(() => (lr.className = 'last-result'), 1100);
  if (navigator.vibrate) navigator.vibrate(r ? 60 : [40, 60, 40]);
}

function updateScore() {
  if (!T) return;
  const st = sessionStats(T);
  $('#s-makes').textContent = st.makes;
  $('#s-att').textContent = st.attempts;
  $('#s-pct').textContent = st.attempts ? `${st.pct}%` : '—';
  $('#s-streak').textContent = T.streak >= 2 ? `🔥 ${T.streak} подряд` : '';
  $('#last-shots').innerHTML = T.shots.slice(-10).map((x) => `<i class="${x.r ? 'm' : 'x'}"></i>`).join('');
  updateProgress();
}

function updateProgress() {
  if (!T) return;
  let p = '';
  if (T.target) p = `${T.shots.length} / ${T.target}`;
  if (T.durationMs) p = `осталось ${fmtDur(Math.max(0, T.durationMs - T.activeMs))}`;
  if (T.spots) p = `Точка ${T.spotIdx + 1}/${T.spots.length}: ${T.spots[T.spotIdx]} · ${T.spotShots}/${T.perSpot}`;
  $('#progress').textContent = p;
}

function tickTime(now) {
  if (!T) return;
  const dt = now - T.lastTick;
  T.lastTick = now;
  if (T.started && !T.paused && !T.finished && now >= T.goAt) T.activeMs += dt;
}

// Таймер, переходы между точками, обратный отсчёт.
setInterval(() => {
  if (!T || T.finished || !running) return;
  const now = performance.now();
  tickTime(now);
  $('#timer').textContent = fmtDur(T.activeMs);
  updateProgress();

  if (T.started && !T.paused && now < T.goAt) {
    const left = Math.ceil((T.goAt - now) / 1000);
    showCenter(`<span class="big">${left}</span>${T.spots ? esc(T.spots[T.spotIdx]) : 'Занимайте позицию'}`);
    if (left !== T._lastCount) {
      T._lastCount = left;
      if (left <= 3) sound.play('tick');
    }
  } else if (T.started && !T.paused && T._lastCount) {
    T._lastCount = 0;
    hideCenter();
    sound.play('go');
    voice.say('Бросайте!');
  }

  if (T.paused === 'transition') {
    const left = Math.ceil((T.transitionUntil - now) / 1000);
    if (left > 0) {
      showCenter(`<span class="big">${left}</span>Переход: ${esc(T.spots[T.spotIdx])}<small>Точка ${T.spotIdx + 1} из ${T.spots.length}</small>`);
      if (left !== T._lastTr) {
        T._lastTr = left;
        if (left <= 3) sound.play('tick');
      }
    } else {
      T.paused = null;
      T._lastTr = 0;
      hideCenter();
      sound.play('go');
      voice.say('Бросайте!');
    }
  }

  if (T.durationMs) {
    const left = T.durationMs - T.activeMs;
    if (left <= 60000 && left > 50000 && !T.warned.min && T.durationMs > 120000) {
      T.warned.min = true;
      voice.say('Осталась минута');
    }
    if (left <= 10000 && !T.warned.ten) {
      T.warned.ten = true;
      voice.say('10 секунд');
    }
    if (left <= 0) finishTraining();
  }

  if (!T.started && running && now - HI.searchStart > 9000 && !T._hintShown) {
    T._hintShown = true;
    showCenter('Не вижу кольцо<small>Приблизьте камеру (+ или щипок), чтобы кольцо с сеткой было крупнее, — или нажмите ◎ и коснитесь кольца.</small>');
    voice.say('Не вижу кольцо. Приблизьте камеру или укажите кольцо касанием');
  }
  if (T.started && !T.paused && !detector.rimLocked) setStatus('Кольцо потеряно — ищу…', 'warn');
  else if (T.paused === 'user') setStatus('Пауза', 'warn');
  else if (T.paused === 'transition') setStatus('Переход', 'warn');
  else if (isCounting(now)) setStatus(detector.rimManual ? 'Слежу (кольцо вручную)' : 'Слежу за мячом', 'ok');
}, 250);

function pauseTraining(reason = 'user') {
  if (!T || T.finished || T.paused === reason) return;
  tickTime(performance.now());
  T.paused = reason;
  detector.suspend(100);
  if (T.video) {
    video.pause();
    $('#v-play').textContent = '▶';
  }
  $('#b-pause').textContent = '▶';
  if (reason === 'user') {
    showCenter('Пауза<small>Скажите «продолжить» или нажмите ▶</small>');
    voice.say('Пауза', { interrupt: true });
  }
}

function resumeTraining() {
  if (!T || T.finished || !T.paused) return;
  if (T.paused === 'transition') {
    T.transitionUntil = performance.now();
    return;
  }
  T.lastTick = performance.now();
  T.paused = null;
  $('#b-pause').textContent = '❚❚';
  hideCenter();
  if (T.video) {
    video.play().catch(() => {});
    $('#v-play').textContent = '❚❚';
    voice.cancel();
    return;
  }
  detector.suspend(800);
  voice.say('Продолжаем', { interrupt: true });
}

function finishTraining() {
  if (!T || T.finished) return;
  tickTime(performance.now());
  T.finished = true;
  running = false;
  camera.stop();
  closeVideo();
  commands.stop();
  releaseWakeLock();
  closeModal();
  $('#rim-panel').classList.add('hidden');
  const st = sessionStats(T);
  const session = {
    id: T.id,
    startedAt: T.startedAt,
    mode: T.mode,
    modeLabel: T.modeLabel,
    activeMs: Math.round(T.activeMs),
    shots: T.shots,
    ...(T.spots ? { spots: T.spots, perSpot: T.perSpot } : {}),
  };
  const prev = aggregate(loadSessions());
  const isVideo = !!T.video;
  if (st.attempts && !isVideo) saveSession(session);
  sound.play('end');
  voice.say(st.attempts ? `Тренировка завершена. ${st.makes} из ${st.attempts}, ${st.pct} процентов` : 'Тренировка завершена', {
    interrupt: true,
    delay: 300,
  });
  lastSummaryId = st.attempts && !isVideo ? session.id : null;
  if (!isVideo) lastVideoFile = null;
  $('#summary-body').innerHTML = isVideo
    ? videoReport(session, T)
    : st.attempts
      ? renderSessionDetail(session, { compareTo: prev.attempts >= 20 ? prev.pct : null }) + recordNote(session, prev)
      : `<div class="empty">Ни одного броска не засчитано — тренировка не сохранена.</div>`;
  $('#sum-share').classList.toggle('hidden', !lastSummaryId);
  $('#sum-again').textContent = isVideo ? '⟲ Прогнать это видео ещё раз' : '▶ Ещё тренировка';
  T = null;
  go('summary');
}

function videoReport(session, t) {
  const st = sessionStats(session);
  const rows = t.events.length
    ? `<ul class="events">${t.events
        .map((e) => `<li><span class="mono">${fmtDur(e.vt * 1000)}</span><span class="${e.r ? 'm' : 'x'}">${e.r ? 'Попадание' : 'Промах'}${e.m ? ' (вручную)' : ''}</span></li>`)
        .join('')}</ul>`
    : '<p class="hint">Бросков не найдено. Проверьте, что кольцо целиком в кадре и над ним видна дуга мяча; попробуйте другую чувствительность в настройках.</p>';
  return `<div class="card">
      <div class="big-sub">🎬 ${esc(t.video.name)}</div>
      <div class="big-pct">${st.attempts ? st.pct + '%' : '—'}</div>
      <div class="big-sub"><b style="color:var(--ok)">${st.makes}</b> из <b>${st.attempts}</b></div>
    </div>
    <div class="card"><div class="opt-title">Что распознано (время в ролике)</div>${rows}</div>
    ${t.cameraMoved ? `<div class="card" style="color:var(--accent2)">⚠️ В ролике камера двигалась (${t.cameraMoved} раз). Приложение рассчитано на неподвижный телефон на штативе: пока кадр движется, броски не считаются, а результат может быть неточным.</div>` : ''}
    <p class="hint">Проверка на видео не сохраняется в историю тренировок.</p>`;
}

function recordNote(s, prev) {
  const st = sessionStats(s);
  const notes = [];
  if (st.bestStreak > prev.bestStreak && prev.sessions) notes.push(`Новый рекорд серии: ${st.bestStreak} подряд!`);
  if (st.attempts >= 10 && st.pct > prev.best && prev.sessions) notes.push(`Лучшая точность за всё время: ${st.pct}%!`);
  return notes.map((n) => `<div class="card" style="text-align:center;font-weight:700;color:var(--accent2)">🏆 ${esc(n)}</div>`).join('');
}

$('#sum-again').addEventListener('click', () => {
  sound.unlock();
  startTraining(lastVideoFile);
});

// ── Проверка на видео ──
$('#video-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  sound.unlock();
  startTraining(f);
});
function toggleVideo() {
  if (!T?.video) return;
  if (video.paused || T.paused) T.paused ? resumeTraining() : video.play();
  else pauseTraining('user');
}
$('#v-play').addEventListener('click', toggleVideo);
$('#v-restart').addEventListener('click', () => {
  if (!T?.video) return;
  T.shots = [];
  T.events = [];
  T.streak = 0;
  T.activeMs = 0;
  updateScore();
  video.currentTime = 0;
  detector.resetTime();
  if (T.paused) resumeTraining();
  else video.play().catch(() => {});
  toast('Проверка заново');
});
$('#v-speed').addEventListener('click', () => {
  const i = (SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length;
  video.playbackRate = SPEEDS[i];
  settings.videoSpeed = SPEEDS[i];
  saveSettings(settings);
  $('#v-speed').textContent = `${SPEEDS[i]}×`;
});
let seeking = false;
$('#v-seek').addEventListener('input', () => {
  seeking = true;
  if (video.duration) video.currentTime = (Number($('#v-seek').value) / 1000) * video.duration;
});
$('#v-seek').addEventListener('change', () => {
  seeking = false;
  detector.resetTime();
});
video.addEventListener('ended', () => {
  if (T?.video && !T.finished) setTimeout(() => T?.video && finishTraining(), 900);
});
setInterval(() => {
  if (!T?.video || !video.duration) return;
  $('#v-time').textContent = `${fmtDur(video.currentTime * 1000)} / ${fmtDur(video.duration * 1000)}`;
  if (!seeking) $('#v-seek').value = String(Math.round((video.currentTime / video.duration) * 1000));
}, 250);
$('#sum-share').addEventListener('click', async () => {
  const s = loadSessions().find((x) => x.id === lastSummaryId);
  if (!s) return;
  const st = sessionStats(s);
  const text = `🏀 Тренировка бросков: ${st.makes} из ${st.attempts} (${st.pct}%), лучшая серия — ${st.bestStreak}, время ${fmtDur(s.activeMs)}.`;
  try {
    if (window.AndroidApp) window.AndroidApp.shareText(text);
    else if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      toast('Скопировано в буфер обмена');
    }
  } catch {
    /* отменено */
  }
});

// ── Голосовые команды ──
function onVoiceCommand(cmd) {
  if (!T || T.finished) return;
  bumpControls();
  switch (cmd) {
    case 'pause': pauseTraining('user'); break;
    case 'resume': resumeTraining(); break;
    case 'finish': finishTraining(); break;
    case 'undo': undoShot(); break;
    case 'make': registerShot(1, true); break;
    case 'miss': registerShot(0, true); break;
    case 'zoom-in': setZoom(Z.total * 1.25, rimBase ? { x: rimBase.x, y: rimBase.y } : null); break;
    case 'zoom-out': setZoom(Z.total / 1.25); break;
    case 'score': {
      const st = sessionStats(T);
      voice.say(`${st.makes} из ${st.attempts}, ${st.pct} процентов. Время ${Math.floor(T.activeMs / 60000)} минут`, { interrupt: true });
      break;
    }
  }
}

// ── Кнопки на экране тренировки ──
$('#m-make').addEventListener('click', () => registerShot(1, true));
$('#m-miss').addEventListener('click', () => registerShot(0, true));
$('#m-undo').addEventListener('click', undoShot);
$('#b-pause').addEventListener('click', () => (T?.video ? toggleVideo() : T?.paused === 'user' ? resumeTraining() : pauseTraining('user')));
$('#b-stop').addEventListener('click', () => {
  if (!T) return;
  if (!T.shots.length) return finishTraining();
  modal(
    `<h2>Завершить тренировку?</h2><p>${shotsWord(T.shots.length)} будут сохранены в истории.</p>
     <div class="btn-col"><button class="btn primary big" id="fin-yes">Завершить</button><button class="btn" id="fin-no">Продолжить</button></div>`,
    (b) => {
      b.querySelector('#fin-yes').addEventListener('click', finishTraining);
      b.querySelector('#fin-no').addEventListener('click', closeModal);
    },
  );
});
$('#z-in').addEventListener('click', () => setZoom(Z.total * 1.25, Z.total <= 1.001 && rimBase ? { x: rimBase.x, y: rimBase.y } : null));
$('#z-out').addEventListener('click', () => setZoom(Z.total / 1.25));
$('#z-val').addEventListener('click', () => (rimBase ? autoZoom(true) : setZoom(1)));

// Ручная разметка кольца
let rimTapMode = false;
$('#b-rim').addEventListener('click', () => {
  rimTapMode = !rimTapMode;
  $('#rim-panel').classList.toggle('hidden', !rimTapMode);
  $('#b-rim').classList.toggle('on', rimTapMode);
  if (rimTapMode && detector.rim) $('#rim-size').value = ((detector.rim.w / V.pw) * 100).toFixed(1);
});
$('#rim-done').addEventListener('click', () => $('#b-rim').click());
$('#rim-auto').addEventListener('click', () => {
  detector.clearRim();
  rimBase = null;
  setStatus('Ищу кольцо…', 'warn');
  $('#b-rim').click();
});
$('#rim-size').addEventListener('input', () => {
  if (!detector.rimManual || !detector.rim) return;
  const w = (Number($('#rim-size').value) / 100) * V.pw;
  detector.setRim({ ...detector.rim, w, h: w * 0.25 }, { manual: true });
  rimBase = procToBase(detector.rim);
});

function setManualRim(px, py) {
  let near = null;
  if (HI.acc && HI.n) {
    const k = HI.w / V.pw;
    const r = mainLocator.near(Uint8Array.from(HI.acc), HI.w, HI.h, px * k, py * k, warmMask());
    if (r) near = { cx: r.cx / k, cy: r.cy / k, w: r.w / k, h: Math.max(2, r.h / k) };
  }
  near ||= detector.rimNear(px, py);
  const w = near ? near.w : (Number($('#rim-size').value) / 100) * V.pw;
  const r = near || { cx: px, cy: py, w, h: w * 0.25 };
  const wasStarted = T?.started;
  detector.setRim(r, { manual: true });
  rimBase = procToBase(r);
  $('#rim-size').value = ((r.w / V.pw) * 100).toFixed(1);
  if (T && !wasStarted) handleEvent({ type: 'rim-found' }, performance.now());
  else {
    sound.play('ready');
    toast('Кольцо задано вручную');
  }
}

// Жесты: щипок — зум, перетаскивание — сдвиг кадра, двойной тап — авто-зум, тап в режиме ◎ — кольцо.
const pointers = new Map();
let pinch = null, pan = null, lastTap = 0, tapStart = null;
view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tapStart = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: Z.total };
    pan = null;
  } else if (pointers.size === 1) {
    pan = { x: e.clientX, y: e.clientY, fx: Z.fx, fy: Z.fy };
  }
});
view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const z = Math.min(maxZoom(), Math.max(1, (pinch.z * d) / pinch.d));
    if (Math.abs(z - Z.total) > 0.05) {
      Z.total = z;
      applyView();
    }
  } else if (pan && pointers.size === 1 && Z.total > 1.01 && !rimTapMode) {
    const r = view.getBoundingClientRect();
    const fitW = Math.min(r.width / V.crop.w, r.height / V.crop.h) * V.crop.w; // ширина картинки на экране
    const dx = (e.clientX - pan.x) / fitW / Z.total;
    const dy = (e.clientY - pan.y) / ((fitW * V.vh) / V.vw) / Z.total;
    Z.fx = Math.min(1, Math.max(0, pan.fx - dx));
    Z.fy = Math.min(1, Math.max(0, pan.fy - dy));
    applyView();
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) pan = null;
  if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) < 12 && performance.now() - tapStart.t < 350) {
    const now = performance.now();
    if (rimTapMode) {
      const p = canvasToProc(e.clientX, e.clientY);
      if (p) setManualRim(p.x, p.y);
    } else if (now - lastTap < 320) {
      rimBase ? autoZoom(true) : setZoom(1);
      lastTap = 0;
    } else lastTap = now;
  }
  tapStart = null;
};
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);

// Прятать (приглушать) панель управления, когда её не трогают.
let dimTimer = 0;
function bumpControls() {
  $('#controls').classList.remove('dim');
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => $('#controls').classList.add('dim'), 6000);
}
$('#screen-train').addEventListener('pointerdown', bumpControls, true);

// ───────────────────────────── Отрисовка ─────────────────────────────
const fit = { dx: 0, dy: 0, s: 1 };

function resizeView() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view.width = Math.round(view.clientWidth * dpr);
  view.height = Math.round(view.clientHeight * dpr);
}
window.addEventListener('resize', () => {
  if (running) resizeView();
});

function canvasToProc(clientX, clientY) {
  const r = view.getBoundingClientRect();
  const dpr = view.width / r.width;
  const x = ((clientX - r.left) * dpr - fit.dx) / fit.s;
  const y = ((clientY - r.top) * dpr - fit.dy) / fit.s;
  if (x < 0 || y < 0 || x > V.pw || y > V.ph) return null;
  return { x, y };
}

function draw() {
  const W = view.width, H = view.height;
  if (!W || !H) return;
  const c = V.crop;
  const s = Math.min(W / c.w, H / c.h);
  const dw = c.w * s, dh = c.h * s;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;
  vctx.fillStyle = '#000';
  vctx.fillRect(0, 0, W, H);
  vctx.drawImage(video, c.x, c.y, c.w, c.h, dx, dy, dw, dh);
  fit.dx = dx;
  fit.dy = dy;
  fit.s = dw / V.pw;
  const P = (x, y) => [dx + x * fit.s, dy + y * fit.s];
  const lw = Math.max(2, W / 400);
  const res = lastRes;
  if (!res) return;

  // кандидаты кольца при поиске / найденное кольцо
  const rim = res.rim || detector._rimCand;
  if (rim) {
    const [rx, ry] = P(rim.cx, rim.cy);
    const locked = res.rimLocked;
    vctx.lineWidth = lw * 1.5;
    vctx.strokeStyle = locked ? (res.rimManual ? '#4fc3ff' : '#2fd36b') : 'rgba(255,200,80,.8)';
    vctx.setLineDash(locked ? [] : [8, 8]);
    vctx.beginPath();
    vctx.ellipse(rx, ry, (rim.w / 2) * fit.s + lw * 2, Math.max(4, (rim.h / 2) * fit.s + lw * 2), 0, 0, Math.PI * 2);
    vctx.stroke();
    vctx.setLineDash([]);
    if (locked) {
      // зона, выше которой мяч «вооружает» бросок
      vctx.strokeStyle = 'rgba(255,255,255,.25)';
      vctx.lineWidth = lw * 0.6;
      vctx.beginPath();
      vctx.moveTo(rx - rim.w * 1.5 * fit.s, ry);
      vctx.lineTo(rx + rim.w * 1.5 * fit.s, ry);
      vctx.stroke();
    }
  }

  // траектории текущих бросков (в групповой тренировке их может быть несколько одновременно)
  for (const sh of res.shots || []) {
    if (sh.pts.length < 2) continue;
    vctx.strokeStyle = '#ff9a3c';
    vctx.lineWidth = lw * 1.4;
    vctx.beginPath();
    sh.pts.forEach((p, i) => {
      const [x, y] = P(p.x, p.y);
      i ? vctx.lineTo(x, y) : vctx.moveTo(x, y);
    });
    vctx.stroke();
  }
  // мяч(и)
  for (const tr of res.tracks) {
    if (tr.lastSeen !== detector.lastT) continue;
    const p = tr.pts[tr.pts.length - 1];
    if (!settings.showDebug && !(tr.travel > tr.d * 1.5 && tr.pts.length > 2)) continue;
    const [x, y] = P(p.x, p.y);
    vctx.strokeStyle = res.shots?.some((sh) => sh.track === tr) ? '#ff9a3c' : 'rgba(255,255,255,.7)';
    vctx.lineWidth = lw;
    vctx.beginPath();
    vctx.arc(x, y, (tr.d / 2) * fit.s + lw * 2, 0, Math.PI * 2);
    vctx.stroke();
    if (settings.showDebug) {
      vctx.strokeStyle = 'rgba(80,200,255,.6)';
      vctx.beginPath();
      tr.pts.forEach((q, i) => {
        const [a, b] = P(q.x, q.y);
        i ? vctx.lineTo(a, b) : vctx.moveTo(a, b);
      });
      vctx.stroke();
    }
  }
  if (settings.showDebug) {
    vctx.fillStyle = 'rgba(255,255,0,.8)';
    for (const cd of res.candidates) {
      const [x, y] = P(cd.x, cd.y);
      vctx.fillRect(x - 3, y - 3, 6, 6);
    }
    vctx.fillStyle = '#fff';
    vctx.font = `${Math.round(12 * (W / view.clientWidth))}px monospace`;
    vctx.fillText(`${V.pw}×${V.ph} · ${procAvg.toFixed(1)} мс · сетка ${detector.netScore.toFixed(2)}`, dx + 8, dy + dh - 10);
  }
}

// ── Статус/сообщения ──
function setStatus(text, cls = '') {
  const s = $('#status');
  if (s.textContent !== text) s.textContent = text;
  s.className = `pill ${cls}`;
}
function showCenter(html) {
  const c = $('#center-msg');
  if (c.innerHTML !== html) c.innerHTML = html;
  c.classList.remove('hidden');
}
function hideCenter() {
  $('#center-msg').classList.add('hidden');
}

// ── Экран не гаснет ──
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (!T || T.finished) return;
  if (document.hidden) {
    if (!T.paused) pauseTraining('hidden');
  } else {
    requestWakeLock();
    if (T.paused === 'hidden') {
      T.lastTick = performance.now();
      T.paused = null;
      $('#b-pause').textContent = '❚❚';
      detector.resetBackground();
      detector.suspend(1000);
      if (T.video) $('#v-play').textContent = '❚❚';
    }
    if (T.video) {
      if (T.paused === null) video.play().catch(() => {});
    } else if (!video.srcObject?.active && running) camera.start({ resolution: settings.resolution }).then(() => applyView()).catch(() => {});
  }
});

// ───────────────────────────── История ─────────────────────────────
function showHistory() {
  const sessions = loadSessions();
  renderHistory($('#history-body'), sessions, {
    view: historyView,
    onView: (v) => {
      historyView = v;
      showHistory();
    },
    onOpen: (id) => {
      const s = loadSessions().find((x) => x.id === id);
      if (!s) return;
      modal(renderSessionDetail(s) + `<div class="btn-col"><button class="btn danger" id="del-s">Удалить тренировку</button></div>`, (b) =>
        b.querySelector('#del-s').addEventListener('click', () => {
          if (!confirm('Удалить эту тренировку?')) return;
          deleteSession(id);
          closeModal();
          showHistory();
        }),
      );
    },
  });
}

function download(name, text, type) {
  if (window.AndroidApp) {
    window.AndroidApp.saveFile(name, type.split(';')[0], text);
    return;
  }
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
$('#h-export').addEventListener('click', () => download(`snaiper-${stamp()}.json`, JSON.stringify(loadSessions(), null, 1), 'application/json'));
$('#h-csv').addEventListener('click', () => download(`snaiper-${stamp()}.csv`, sessionsToCSV(loadSessions()), 'text/csv;charset=utf-8'));
$('#h-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const n = importSessions(JSON.parse(await f.text()));
    toast(`Импортировано тренировок: ${n}`);
    showHistory();
  } catch (err) {
    toast(`Ошибка импорта: ${err.message}`);
  }
  e.target.value = '';
});

// ───────────────────────────── Настройки ─────────────────────────────
const form = $('#settings-form');
$('#sound-pack').innerHTML = Object.entries(SOUND_PACKS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
if (!commands.supported) {
  form.voiceCommands.disabled = true;
  $('#cmd-hint').textContent = 'Голосовые команды не поддерживаются этим браузером (работают в Chrome на Android).';
}

function fillSettings() {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = String(settings[el.name]);
  }
  $('#vol-out').textContent = `${Math.round(settings.volume * 100)}%`;
}

form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name || !(el.name in settings)) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.name === 'volume') v = Number(v);
  if (el.name === 'procSize') v = Number(v);
  settings[el.name] = v;
  saveSettings(settings);
  sound.pack = settings.soundPack;
  sound.setVolume(settings.volume);
  detector.setSensitivity(settings.sensitivity);
  voice.enabled = settings.voiceMode !== 'off';
  $('#vol-out').textContent = `${Math.round(settings.volume * 100)}%`;
  if (el.name === 'soundPack') {
    sound.unlock();
    sound.play('make');
  }
});
$('#test-make').addEventListener('click', () => {
  sound.unlock();
  sound.play('make');
});
$('#test-miss').addEventListener('click', () => {
  sound.unlock();
  sound.play('miss');
});
$('#clear-all').addEventListener('click', () => {
  if (confirm('Удалить всю историю тренировок? Это нельзя отменить.')) {
    clearSessions();
    toast('История удалена');
  }
});

// ───────────────────────────── Запуск ─────────────────────────────
renderHome();
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.AndroidApp) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Кнопка «Назад» в Android-приложении: true — обработано здесь, false — выйти из приложения.
window.__snaiperBack = () => {
  if (!$('#modal').classList.contains('hidden')) {
    closeModal();
    return true;
  }
  if (rimTapMode) {
    $('#b-rim').click();
    return true;
  }
  if (T && !T.finished) {
    $('#b-stop').click();
    return true;
  }
  if (!$('#screen-home').classList.contains('active')) {
    go('home');
    return true;
  }
  return false;
};

// для автотестов и отладки
window.__snaiper = {
  detector, settings, get T() { return T; }, Z, V,
  // для проверок на видео: задать кольцо в координатах исходного видео (как касание ◎ с точным размером)
  setRimVideo(x, y, w) {
    const k = V.pw / V.crop.w;
    const r = { cx: (x - V.crop.x) * k, cy: (y - V.crop.y) * k, w: w * k, h: w * k * 0.25 };
    const was = T?.started;
    detector.setRim(r, { manual: true });
    rimBase = procToBase(r);
    if (T && !was) handleEvent({ type: 'rim-found' }, performance.now());
    if (settings.autoZoom) autoZoom(false);
  },
};
