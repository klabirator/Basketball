// Отрисовка истории тренировок, графика прогресса и карточки итогов.
import { sessionStats } from './storage.js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const shotsWord = (n) => `${n} ${plural(n, 'бросок', 'броска', 'бросков')}`;

export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function dayLabel(ts) {
  const today = dayKey(Date.now());
  const yest = dayKey(Date.now() - 864e5);
  const k = dayKey(ts);
  if (k === today) return 'Сегодня';
  if (k === yest) return 'Вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'short' });
}

export function aggregate(sessions, sinceTs = 0) {
  let attempts = 0, makes = 0, n = 0, best = 0, bestStreak = 0, ms = 0;
  for (const s of sessions) {
    if (s.startedAt < sinceTs) continue;
    const st = sessionStats(s);
    attempts += st.attempts;
    makes += st.makes;
    ms += s.activeMs || 0;
    n++;
    if (st.attempts >= 10 && st.pct > best) best = st.pct;
    if (st.bestStreak > bestStreak) bestStreak = st.bestStreak;
  }
  return { attempts, makes, pct: attempts ? Math.round((makes / attempts) * 100) : null, sessions: n, best, bestStreak, ms };
}

function chartSVG(points) {
  // points: [{label, pct, attempts}]
  const W = 600, H = 220, L = 34, R = 10, T = 12, B = 26;
  if (!points.length) return '';
  const n = points.length;
  const x = (i) => (n === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (p) => T + (1 - p / 100) * (H - T - B);
  const maxAtt = Math.max(...points.map((p) => p.attempts), 1);
  let g = '';
  for (const v of [0, 25, 50, 75, 100]) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  }
  // столбики — объём бросков
  const bw = Math.max(3, Math.min(18, ((W - L - R) / n) * 0.5));
  points.forEach((p, i) => {
    const h = (p.attempts / maxAtt) * (H - T - B) * 0.35;
    g += `<rect x="${x(i) - bw / 2}" y="${H - B - h}" width="${bw}" height="${h}" rx="2" fill="var(--card2)"/>`;
  });
  // скользящее среднее
  if (n >= 4) {
    const k = Math.min(5, Math.floor(n / 2));
    const ma = points.map((_, i) => {
      const sl = points.slice(Math.max(0, i - k + 1), i + 1);
      const a = sl.reduce((s, p) => s + p.attempts, 0);
      const m = sl.reduce((s, p) => s + (p.pct * p.attempts) / 100, 0);
      return a ? (m / a) * 100 : 0;
    });
    g += `<polyline fill="none" stroke="var(--accent2)" stroke-width="2" stroke-dasharray="5 5" points="${ma.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`;
  }
  g += `<polyline fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round" points="${points.map((p, i) => `${x(i)},${y(p.pct)}`).join(' ')}"/>`;
  points.forEach((p, i) => {
    g += `<circle cx="${x(i)}" cy="${y(p.pct)}" r="4.5" fill="var(--accent)"><title>${esc(p.label)}: ${p.pct}% (${shotsWord(p.attempts)})</title></circle>`;
  });
  const first = points[0].label, last = points[n - 1].label;
  g += `<text x="${L}" y="${H - 6}">${esc(first)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(last)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="График точности">${g}</svg>`;
}

export function renderHistory(el, sessions, { onOpen, view = 'sessions', onView }) {
  if (!sessions.length) {
    el.innerHTML = `<div class="empty">Пока нет тренировок.<br>Начните первую — результаты сохранятся здесь.</div>`;
    return;
  }
  const all = aggregate(sessions);
  const week = aggregate(sessions, Date.now() - 7 * 864e5);
  const month = aggregate(sessions, Date.now() - 30 * 864e5);

  let points;
  if (view === 'days') {
    const map = new Map();
    for (const s of sessions) {
      const k = dayKey(s.startedAt);
      const st = sessionStats(s);
      const v = map.get(k) || { attempts: 0, makes: 0, ts: s.startedAt };
      v.attempts += st.attempts;
      v.makes += st.makes;
      map.set(k, v);
    }
    points = [...map.values()].slice(-30).map((v) => ({
      label: new Date(v.ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
      pct: v.attempts ? Math.round((v.makes / v.attempts) * 100) : 0,
      attempts: v.attempts,
    }));
  } else {
    points = sessions.filter((s) => s.shots.length).slice(-30).map((s) => {
      const st = sessionStats(s);
      return { label: new Date(s.startedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }), pct: st.pct, attempts: st.attempts };
    });
  }

  let html = `
  <div class="card">
    <div class="kv">
      <div><b>${all.pct ?? '—'}%</b><small>Точность за всё время</small></div>
      <div><b>${week.pct ?? '—'}${week.pct != null ? '%' : ''}</b><small>За 7 дней (${shotsWord(week.attempts)})</small></div>
      <div><b>${month.pct ?? '—'}${month.pct != null ? '%' : ''}</b><small>За 30 дней</small></div>
      <div><b>${all.attempts}</b><small>Всего бросков</small></div>
      <div><b>${all.sessions}</b><small>Тренировок</small></div>
      <div><b>${fmtDur(all.ms)}</b><small>Время в зале</small></div>
      <div><b>${all.best ? all.best + '%' : '—'}</b><small>Лучшая тренировка (от 10 бросков)</small></div>
      <div><b>${all.bestStreak}</b><small>Рекордная серия попаданий</small></div>
    </div>
  </div>
  <div class="card">
    <div class="seg" id="h-view">
      <button data-v="sessions" class="${view === 'sessions' ? 'on' : ''}">По тренировкам</button>
      <button data-v="days" class="${view === 'days' ? 'on' : ''}">По дням</button>
    </div>
    ${chartSVG(points)}
    <p class="hint">Линия — точность, пунктир — тренд, столбики — количество бросков.</p>
  </div>`;

  let lastDay = '';
  for (const s of [...sessions].reverse()) {
    const k = dayKey(s.startedAt);
    if (k !== lastDay) {
      html += `<div class="day-label">${esc(dayLabel(s.startedAt))}</div>`;
      lastDay = k;
    }
    const st = sessionStats(s);
    const time = new Date(s.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    html += `<button class="sess" data-id="${esc(s.id)}">
      <div><b>${st.makes} / ${st.attempts}</b><small>${esc(time)} · ${esc(s.modeLabel || '')} · ${fmtDur(s.activeMs || 0)}</small></div>
      <div class="pct">${st.pct}%</div>
    </button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.sess').forEach((b) => b.addEventListener('click', () => onOpen(b.dataset.id)));
  el.querySelectorAll('#h-view button').forEach((b) => b.addEventListener('click', () => onView(b.dataset.v)));
}

export function renderSessionDetail(s, { compareTo = null } = {}) {
  const st = sessionStats(s);
  const mins = (s.activeMs || 0) / 60000;
  const pace = mins > 0.2 ? (st.attempts / mins).toFixed(1) : '—';
  let html = `
    <div class="card">
      <div class="big-pct">${st.attempts ? st.pct + '%' : '—'}</div>
      <div class="big-sub"><b style="color:var(--ok)">${st.makes}</b> из <b>${st.attempts}</b> · ${esc(s.modeLabel || '')}</div>
      ${compareTo != null && st.attempts ? `<p class="hint" style="text-align:center">${compareLine(st.pct, compareTo)}</p>` : ''}
    </div>
    <div class="card kv">
      <div><b>${fmtDur(s.activeMs || 0)}</b><small>Время</small></div>
      <div><b>${st.bestStreak}</b><small>Лучшая серия</small></div>
      <div><b>${pace}</b><small>Бросков в минуту</small></div>
      <div><b>${st.misses}</b><small>Промахов</small></div>
    </div>`;
  if (s.spots?.length) {
    html += `<div class="card"><table class="spots"><tr><th>Точка</th><th>Результат</th></tr>`;
    s.spots.forEach((name, i) => {
      const v = st.bySpot[i] || { attempts: 0, makes: 0 };
      const p = v.attempts ? Math.round((v.makes / v.attempts) * 100) : 0;
      html += `<tr><td>${i + 1}. ${esc(name)}<div class="bar"><i style="width:${p}%"></i></div></td><td><b>${v.makes}/${v.attempts}</b> · ${v.attempts ? p + '%' : '—'}</td></tr>`;
    });
    html += `</table></div>`;
  }
  if (s.shots.length) {
    html += `<div class="card"><div class="opt-title">Последовательность бросков</div><div class="dots">${s.shots
      .map((x) => `<i class="${x.r ? 'm' : ''} ${x.m ? 'manual' : ''}" title="${fmtDur(x.t)}"></i>`)
      .join('')}</div>
      ${s.shots.some((x) => x.m) ? '<p class="hint">Обведены броски, добавленные вручную.</p>' : ''}
      ${halves(s)}</div>`;
  }
  html += `<p class="hint">${esc(new Date(s.startedAt).toLocaleString('ru-RU', { dateStyle: 'full', timeStyle: 'short' }))}</p>`;
  return html;
}

function halves(s) {
  const n = s.shots.length;
  if (n < 10) return '';
  const h = Math.floor(n / 2);
  const p = (arr) => Math.round((arr.filter((x) => x.r).length / arr.length) * 100);
  const a = p(s.shots.slice(0, h)), b = p(s.shots.slice(h));
  const note = b - a >= 8 ? 'к концу вы разогрелись 🔥' : a - b >= 8 ? 'к концу точность упала — возможно, усталость' : 'стабильно на протяжении тренировки';
  return `<p class="hint">Первая половина: ${a}% · вторая: ${b}% — ${note}.</p>`;
}

function compareLine(pct, avg) {
  const d = pct - avg;
  if (Math.abs(d) < 2) return `На уровне вашего среднего (${avg}%).`;
  return d > 0 ? `На ${d}% лучше вашего среднего (${avg}%) 👏` : `На ${-d}% ниже вашего среднего (${avg}%).`;
}
