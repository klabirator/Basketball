// Локальное хранение тренировок и настроек (localStorage, всё остаётся на телефоне).

const SESSIONS_KEY = 'snaiper.sessions.v1';
const SETTINGS_KEY = 'snaiper.settings.v1';

export const DEFAULT_SETTINGS = {
  soundPack: 'classic',
  volume: 1,
  voiceMode: 'every5', // off | every | every5 | every10
  voiceCommands: false,
  streakAlerts: true,
  sensitivity: 'medium',
  autoZoom: true,
  hwZoom: true,
  resolution: '1080',
  procSize: 400,
  showDebug: false,
  flash: true,
  lastMode: 'free',
  modeOpts: { shots: 50, minutes: 10, program: 'mid5', perSpot: 10 },
  seenHelp: false,
  videoSpeed: 1,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSettings() {
  const s = read(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...s, modeOpts: { ...DEFAULT_SETTINGS.modeOpts, ...(s.modeOpts || {}) } };
}

export function saveSettings(s) {
  write(SETTINGS_KEY, s);
}

export function loadSessions() {
  const list = read(SESSIONS_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveSession(session) {
  const list = loadSessions().filter((s) => s.id !== session.id);
  list.push(session);
  list.sort((a, b) => a.startedAt - b.startedAt);
  return write(SESSIONS_KEY, list);
}

export function deleteSession(id) {
  write(SESSIONS_KEY, loadSessions().filter((s) => s.id !== id));
}

export function clearSessions() {
  write(SESSIONS_KEY, []);
}

export function importSessions(list) {
  if (!Array.isArray(list)) throw new Error('Неверный формат файла');
  const valid = list.filter((s) => s && typeof s.id === 'string' && typeof s.startedAt === 'number' && Array.isArray(s.shots));
  const map = new Map(loadSessions().map((s) => [s.id, s]));
  for (const s of valid) map.set(s.id, s);
  const merged = [...map.values()].sort((a, b) => a.startedAt - b.startedAt);
  write(SESSIONS_KEY, merged);
  return valid.length;
}

export function sessionsToCSV(list) {
  const head = ['дата', 'режим', 'длительность_мин', 'броски', 'попадания', 'процент', 'лучшая_серия'];
  const rows = list.map((s) => {
    const st = sessionStats(s);
    return [
      new Date(s.startedAt).toLocaleString('ru-RU'),
      s.modeLabel || s.mode,
      (s.activeMs / 60000).toFixed(1),
      st.attempts,
      st.makes,
      st.pct,
      st.bestStreak,
    ].join(';');
  });
  return '﻿' + [head.join(';'), ...rows].join('\n');
}

export function sessionStats(s) {
  const shots = s.shots || [];
  const attempts = shots.length;
  const makes = shots.filter((x) => x.r === 1).length;
  let best = 0, cur = 0;
  for (const x of shots) {
    cur = x.r === 1 ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  const pct = attempts ? Math.round((makes / attempts) * 100) : 0;
  const bySpot = {};
  for (const x of shots) {
    const k = x.spot ?? -1;
    bySpot[k] ??= { attempts: 0, makes: 0 };
    bySpot[k].attempts++;
    if (x.r === 1) bySpot[k].makes++;
  }
  return { attempts, makes, misses: attempts - makes, pct, bestStreak: best, bySpot };
}
