'use strict';

const LIFE_START = 6;   // 6 am
const LIFE_END   = 23;  // 11 pm
const WEEK_DAYS  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const LIFE_CATS = [
  { value: 'trading',  label: 'Trading',  color: '#5c8e00' },
  { value: 'work',     label: 'Work',     color: '#2260b0' },
  { value: 'exercise', label: 'Exercise', color: '#e07000' },
  { value: 'learning', label: 'Learning', color: '#7c3aed' },
  { value: 'rest',     label: 'Rest',     color: '#6b7280' },
  { value: 'social',   label: 'Social',   color: '#db2777' },
  { value: 'food',     label: 'Food',     color: '#b45309' },
  { value: 'other',    label: 'Other',    color: '#4b5563' },
];

// ── State ─────────────────────────────────────────────────────────────────
const today      = new Date();
let lifeYear     = today.getFullYear();
let lifeMonth    = today.getMonth() + 1; // 1-based
let lifeCache    = {};   // { "2026-05-12": [{hour, activity, category}] }
let lifeAlarmOn  = true;
let lifeAlarmTimer = null;

// Focus timer state
const lifeFocus = { active: false, hour: null, date: null, endMs: null, intervalId: null };

// Log modal state
let lifeLogHour = null;
let lifeLogDate = null;
let lifeLogMap  = {};

// ── Helpers ───────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtHour(h) { return `${pad(h)}:00`; }
function fmtMonthLabel(y, m) {
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
function fmtDayLabel(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}
function lifeEsc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function msUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return next - now;
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-life-prev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('btn-life-next').addEventListener('click', () => shiftMonth(1));
  document.getElementById('btn-life-today').addEventListener('click', goToday);
  document.getElementById('btn-life-alarm').addEventListener('click', toggleAlarm);

  // Day panel
  document.getElementById('btn-life-day-close').addEventListener('click', closeDayPanel);
  document.getElementById('life-day-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDayPanel();
  });

  // Log modal
  document.getElementById('life-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('btn-life-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('life-modal-form').addEventListener('submit', onModalSubmit);

  // Focus timer cancel
  document.getElementById('btn-life-timer-cancel').addEventListener('click', cancelFocusTimer);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDayPanel(); closeModal(); }
  });

  requestNotifPermission();
  scheduleAlarm();
  initVoice();
});

function onLifeTabActivated() {
  renderCalendar(lifeYear, lifeMonth);
}

// ── Calendar ──────────────────────────────────────────────────────────────
async function renderCalendar(year, month) {
  lifeYear  = year;
  lifeMonth = month;

  document.getElementById('life-month-label').textContent = fmtMonthLabel(year, month);
  const nowStr   = todayStr();
  const isNow    = year === today.getFullYear() && month === today.getMonth() + 1;
  document.getElementById('btn-life-today').classList.toggle('hidden', isNow);

  // Fetch month data
  const data = await fetchMonth(year, month);

  // Group by date
  const byDate = {};
  data.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  });
  // Cache
  Object.entries(byDate).forEach(([d, logs]) => { lifeCache[d] = logs; });

  // Build calendar grid (Mon = col 1)
  const firstDay  = new Date(year, month - 1, 1);
  const lastDay   = new Date(year, month, 0);
  const startCol  = (firstDay.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const totalDays = lastDay.getDate();
  const totalCells = Math.ceil((startCol + totalDays) / 7) * 7;

  const availHours = LIFE_END - LIFE_START + 1;
  let html = '';

  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startCol + 1;
    if (dayNum < 1 || dayNum > totalDays) {
      html += `<div class="life-cal-cell life-cal-cell--empty"></div>`;
      continue;
    }
    const dateStr  = `${year}-${pad(month)}-${pad(dayNum)}`;
    const isToday  = dateStr === nowStr;
    const isPast   = dateStr < nowStr;
    const logs     = byDate[dateStr] || [];
    const filled   = logs.length;
    const pct      = Math.round((filled / availHours) * 100);

    // Category dot colors for filled hours
    const dots = logs.slice(0, 5).map(l => {
      const cat = LIFE_CATS.find(c => c.value === l.category);
      return `<span class="life-cal-dot" style="background:${cat ? cat.color : '#aaa'}"></span>`;
    }).join('');

    html += `
      <div class="life-cal-cell ${isToday ? 'life-cal-cell--today' : ''} ${isPast && !isToday ? 'life-cal-cell--past' : ''}"
           data-date="${dateStr}">
        <span class="life-cal-num">${dayNum}</span>
        ${dots ? `<div class="life-cal-dots">${dots}</div>` : ''}
        ${filled > 0 ? `<div class="life-cal-bar"><div class="life-cal-bar-fill" style="width:${pct}%"></div></div>` : ''}
      </div>
    `;
  }

  const grid = document.getElementById('life-cal-grid');
  grid.innerHTML = html;

  grid.querySelectorAll('.life-cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => openDayPanel(cell.dataset.date));
  });
}

async function fetchMonth(year, month) {
  try {
    const res  = await fetch(`/.netlify/functions/life-log?year=${year}&month=${month}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function shiftMonth(delta) {
  lifeMonth += delta;
  if (lifeMonth > 12) { lifeMonth = 1;  lifeYear++; }
  if (lifeMonth < 1)  { lifeMonth = 12; lifeYear--; }
  renderCalendar(lifeYear, lifeMonth);
}

function goToday() {
  lifeYear  = today.getFullYear();
  lifeMonth = today.getMonth() + 1;
  renderCalendar(lifeYear, lifeMonth);
}

// ── Day Panel ─────────────────────────────────────────────────────────────
function openDayPanel(dateStr) {
  lifeLogMap = {};
  (lifeCache[dateStr] || []).forEach(l => { lifeLogMap[l.hour] = l; });

  document.getElementById('life-day-label').textContent = fmtDayLabel(dateStr);
  renderDayHours(dateStr);

  // Wire voice button for current/past hours — targets current hour or most recent past hour
  const isToday   = dateStr === todayStr();
  const targetHour = isToday
    ? Math.min(new Date().getHours(), LIFE_END)
    : LIFE_END;

  const voiceBtn = document.getElementById('life-voice-btn');
  if (voiceBtn) {
    voiceBtn.onclick = () => {
      if (voiceIsRecording) stopVoice(true);
      else startVoice(targetHour, dateStr);
    };
    voiceBtn.classList.remove('hidden');
  }

  document.getElementById('life-day-overlay').classList.remove('hidden');
}

function closeDayPanel() {
  document.getElementById('life-day-overlay').classList.add('hidden');
}

function renderDayHours(dateStr) {
  const nowStr  = todayStr();
  const isToday = dateStr === nowStr;
  const curHour = isToday ? new Date().getHours() : -1;
  let html = '';

  for (let h = LIFE_START; h <= LIFE_END; h++) {
    const log      = lifeLogMap[h];
    const isCur    = h === curHour;
    const isPast   = isToday ? h < curHour : dateStr < nowStr;
    const isFuture = isToday ? h > curHour : dateStr > nowStr;
    const cat      = log ? LIFE_CATS.find(c => c.value === log.category) : null;
    const isFocus  = lifeFocus.active && lifeFocus.date === dateStr && lifeFocus.hour === h;

    let cls = 'life-hour-block';
    if (isCur)         cls += ' life-hour--current';
    else if (log)      cls += ' life-hour--filled';
    else if (isPast)   cls += ' life-hour--past';
    else if (isFuture) cls += ' life-hour--future';

    html += `
      <div class="${cls}" data-hour="${h}" data-date="${dateStr}">
        <span class="life-hour-time">${fmtHour(h)}</span>
        <div class="life-hour-body">
          ${log
            ? `<span class="life-hour-text">${lifeEsc(log.activity)}</span>`
            : `<span class="life-hour-placeholder">${isCur ? 'Now — tap to log' : isFuture ? '' : 'Not logged'}</span>`
          }
          ${cat ? `<span class="life-hour-cat" style="--cat:${cat.color}">${lifeEsc(cat.label)}</span>` : ''}
        </div>
        <div class="life-hour-actions">
          ${!isFuture ? `<button class="life-hour-btn-edit" data-hour="${h}" data-date="${dateStr}" title="${log ? 'Edit' : 'Log'}">✏</button>` : ''}
          <button class="life-hour-btn-alarm ${isFocus ? 'life-hour-btn-alarm--active' : ''}"
                  data-hour="${h}" data-date="${dateStr}"
                  title="${isFocus ? 'Cancel focus timer' : 'Start 60-min focus timer'}">
            ${isFocus ? `<span class="life-focus-tick" id="focus-tick-${h}">60:00</span>` : '⏰'}
          </button>
        </div>
        ${log ? `<button class="life-hour-btn-del" data-hour="${h}" data-date="${dateStr}" title="Clear">×</button>` : ''}
      </div>
    `;
  }

  const container = document.getElementById('life-day-hours');
  container.innerHTML = html;

  // Edit buttons
  container.querySelectorAll('.life-hour-btn-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openModal(parseInt(btn.dataset.hour), btn.dataset.date);
    });
  });

  // Click block to log
  container.querySelectorAll('.life-hour-block:not(.life-hour--future)').forEach(block => {
    block.addEventListener('click', e => {
      if (e.target.closest('.life-hour-actions') || e.target.closest('.life-hour-btn-del')) return;
      openModal(parseInt(block.dataset.hour), block.dataset.date);
    });
  });

  // Delete buttons
  container.querySelectorAll('.life-hour-btn-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteLog(btn.dataset.date, parseInt(btn.dataset.hour));
      delete lifeLogMap[parseInt(btn.dataset.hour)];
      renderDayHours(btn.dataset.date);
      refreshCalendarCell(btn.dataset.date);
    });
  });

  // Alarm/focus buttons
  container.querySelectorAll('.life-hour-btn-alarm').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const h = parseInt(btn.dataset.hour);
      const d = btn.dataset.date;
      if (lifeFocus.active && lifeFocus.hour === h && lifeFocus.date === d) {
        cancelFocusTimer();
      } else {
        startFocusTimer(h, d);
      }
    });
  });

  // Scroll to current hour
  const cur = container.querySelector('.life-hour--current');
  if (cur) setTimeout(() => cur.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
}

// ── Focus Timer ───────────────────────────────────────────────────────────
function startFocusTimer(hour, date) {
  if (lifeFocus.active) cancelFocusTimer();

  lifeFocus.active   = true;
  lifeFocus.hour     = hour;
  lifeFocus.date     = date;
  lifeFocus.endMs    = Date.now() + 60 * 60 * 1000;
  lifeFocus.intervalId = setInterval(tickFocusTimer, 1000);

  // Show floating timer
  document.getElementById('life-timer-label').textContent = `${fmtHour(hour)} → ${fmtHour(hour + 1)}`;
  document.getElementById('life-timer').classList.remove('hidden');

  tickFocusTimer();
  renderDayHours(date); // re-render to show active state
}

function tickFocusTimer() {
  const remaining = Math.max(0, lifeFocus.endMs - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const display = `${pad(mins)}:${pad(secs)}`;

  document.getElementById('life-timer-display').textContent = display;

  // Update inline tick if day panel is open
  const tick = document.getElementById(`focus-tick-${lifeFocus.hour}`);
  if (tick) tick.textContent = display;

  if (remaining <= 0) {
    focusTimerDone();
  }
}

function focusTimerDone() {
  clearInterval(lifeFocus.intervalId);

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('✅ Focus session complete!', {
      body: `${fmtHour(lifeFocus.hour)}–${fmtHour(lifeFocus.hour + 1)} — time to log what you did.`,
      tag: 'life-focus',
    });
  }

  const completedHour = lifeFocus.hour;
  const completedDate = lifeFocus.date;

  lifeFocus.active = false;
  lifeFocus.hour   = null;
  lifeFocus.date   = null;
  document.getElementById('life-timer').classList.add('hidden');

  // Auto-open log modal
  openModal(completedHour, completedDate);
  if (!document.getElementById('life-day-overlay').classList.contains('hidden')) {
    renderDayHours(completedDate);
  }
}

function cancelFocusTimer() {
  if (!lifeFocus.active) return;
  clearInterval(lifeFocus.intervalId);
  const date = lifeFocus.date;
  lifeFocus.active = false;
  lifeFocus.hour   = null;
  lifeFocus.date   = null;
  document.getElementById('life-timer').classList.add('hidden');
  renderDayHours(date);
}

// ── Log Modal ─────────────────────────────────────────────────────────────
function openModal(hour, date, prefillActivity, prefillCategory) {
  lifeLogHour = hour;
  lifeLogDate = date;
  const existing = lifeLogMap[hour];

  document.getElementById('life-modal-title').textContent = `${fmtHour(hour)} → ${fmtHour(hour + 1)}`;
  document.getElementById('life-modal-activity').value = prefillActivity ?? existing?.activity ?? '';

  const activeCategory = prefillCategory ?? existing?.category;
  const pills = document.getElementById('life-modal-cats');
  pills.innerHTML = LIFE_CATS.map(c => `
    <label class="life-cat-pill" style="--cat:${c.color}">
      <input type="radio" name="life-cat" value="${c.value}" ${activeCategory === c.value ? 'checked' : ''}>
      <span>${lifeEsc(c.label)}</span>
    </label>
  `).join('');

  document.getElementById('life-modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('life-modal-activity').focus(), 50);
}

function closeModal() {
  document.getElementById('life-modal-overlay').classList.add('hidden');
}

async function onModalSubmit(e) {
  e.preventDefault();
  const activity = document.getElementById('life-modal-activity').value.trim();
  const category = document.querySelector('input[name="life-cat"]:checked')?.value || null;
  if (!activity) return;

  await fetch('/.netlify/functions/life-log', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ date: lifeLogDate, hour: lifeLogHour, activity, category }),
  });

  // Update cache
  const entry = { hour: lifeLogHour, activity, category };
  lifeLogMap[lifeLogHour] = entry;
  if (!lifeCache[lifeLogDate]) lifeCache[lifeLogDate] = [];
  const idx = lifeCache[lifeLogDate].findIndex(l => l.hour === lifeLogHour);
  if (idx >= 0) lifeCache[lifeLogDate][idx] = entry;
  else lifeCache[lifeLogDate].push(entry);

  closeModal();
  renderDayHours(lifeLogDate);
  refreshCalendarCell(lifeLogDate);
}

async function deleteLog(date, hour) {
  await fetch(`/.netlify/functions/life-log?date=${encodeURIComponent(date)}&hour=${hour}`, {
    method: 'DELETE',
  });
  if (lifeCache[date]) {
    lifeCache[date] = lifeCache[date].filter(l => l.hour !== hour);
  }
}

// ── Refresh a single calendar cell without full re-render ─────────────────
function refreshCalendarCell(dateStr) {
  const cell = document.querySelector(`.life-cal-cell[data-date="${dateStr}"]`);
  if (!cell) return;

  const logs       = lifeCache[dateStr] || [];
  const availHours = LIFE_END - LIFE_START + 1;
  const pct        = Math.round((logs.length / availHours) * 100);

  const dots = logs.slice(0, 5).map(l => {
    const cat = LIFE_CATS.find(c => c.value === l.category);
    return `<span class="life-cal-dot" style="background:${cat ? cat.color : '#aaa'}"></span>`;
  }).join('');

  let dotsEl = cell.querySelector('.life-cal-dots');
  let barEl  = cell.querySelector('.life-cal-bar');

  if (logs.length > 0) {
    if (!dotsEl) { dotsEl = document.createElement('div'); dotsEl.className = 'life-cal-dots'; cell.appendChild(dotsEl); }
    dotsEl.innerHTML = dots;
    if (!barEl) { barEl = document.createElement('div'); barEl.className = 'life-cal-bar'; barEl.innerHTML = '<div class="life-cal-bar-fill"></div>'; cell.appendChild(barEl); }
    barEl.querySelector('.life-cal-bar-fill').style.width = pct + '%';
  } else {
    dotsEl?.remove();
    barEl?.remove();
  }
}

// ── Voice Assistant ───────────────────────────────────────────────────────
let voiceRecognition  = null;
let voiceTranscript   = '';
let voiceTargetHour   = null;
let voiceTargetDate   = null;
let voiceIsRecording  = false;

function initVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return; // unsupported

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.continuous      = true;
  voiceRecognition.interimResults  = true;
  voiceRecognition.lang            = 'en-US';

  voiceRecognition.onresult = e => {
    let interim = '';
    let final   = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (final) voiceTranscript += ' ' + final;
    setVoiceStatus('listening', (voiceTranscript + interim).trim() || '…');
  };

  voiceRecognition.onerror = err => {
    setVoiceStatus('error', `Mic error: ${err.error}`);
    stopVoice(false);
  };

  voiceRecognition.onend = () => {
    if (voiceIsRecording) voiceRecognition.start(); // keep going
  };
}

function startVoice(hour, date) {
  if (!voiceRecognition) {
    alert('Voice recognition is not supported in this browser. Please use Chrome or Edge.');
    return;
  }
  voiceTargetHour  = hour;
  voiceTargetDate  = date;
  voiceTranscript  = '';
  voiceIsRecording = true;

  const btn = document.getElementById('life-voice-btn');
  if (btn) { btn.classList.add('life-voice-btn--active'); btn.title = 'Stop recording'; }
  setVoiceStatus('listening', '…');
  document.getElementById('life-voice-bar')?.classList.remove('hidden');

  voiceRecognition.start();
}

function stopVoice(process = true) {
  voiceIsRecording = false;
  try { voiceRecognition?.stop(); } catch {}

  const btn = document.getElementById('life-voice-btn');
  if (btn) { btn.classList.remove('life-voice-btn--active'); btn.title = 'Dictate with AI'; }

  if (process && voiceTranscript.trim()) {
    processVoiceWithGroq(voiceTranscript.trim(), voiceTargetHour, voiceTargetDate);
  } else {
    document.getElementById('life-voice-bar')?.classList.add('hidden');
  }
}

async function processVoiceWithGroq(transcript, hour, date) {
  setVoiceStatus('processing', 'AI is processing…');

  try {
    const res  = await fetch('/.netlify/functions/life-voice', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ transcript }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    document.getElementById('life-voice-bar')?.classList.add('hidden');
    openModal(hour, date, data.activity, data.category);
  } catch (err) {
    setVoiceStatus('error', `Failed: ${err.message}`);
    setTimeout(() => document.getElementById('life-voice-bar')?.classList.add('hidden'), 3000);
  }
}

function setVoiceStatus(state, text) {
  const el = document.getElementById('life-voice-status');
  if (!el) return;
  el.textContent  = text;
  el.className    = `life-voice-status life-voice-status--${state}`;
}

// ── Alarm system ──────────────────────────────────────────────────────────
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function scheduleAlarm() {
  if (lifeAlarmTimer) clearTimeout(lifeAlarmTimer);
  lifeAlarmTimer = setTimeout(() => {
    if (lifeAlarmOn) fireHourlyAlarm(new Date().getHours());
    scheduleAlarm();
  }, msUntilNextHour());
}

function fireHourlyAlarm(hour) {
  const prev = hour > 0 ? hour - 1 : 0;
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('⏰ Log your hour', {
      body: `What did you do from ${fmtHour(prev)} to ${fmtHour(hour)}?`,
      tag:  'life-alarm',
    });
  }
  showAlarmToast(prev, hour);
}

function showAlarmToast(from, to) {
  const old = document.getElementById('life-alarm-toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.id = 'life-alarm-toast';
  toast.className = 'life-alarm-toast';
  toast.innerHTML = `
    <span class="life-toast-msg">⏰ Log ${fmtHour(from)}–${fmtHour(to)}</span>
    <button id="btn-toast-log">Log Now</button>
    <button id="btn-toast-dismiss">✕</button>
  `;
  document.body.appendChild(toast);

  toast.querySelector('#btn-toast-log').addEventListener('click', () => {
    toast.remove();
    if (typeof switchTab === 'function') switchTab('life');
    setTimeout(() => {
      openDayPanel(todayStr());
      setTimeout(() => openModal(from, todayStr()), 100);
    }, 200);
  });
  toast.querySelector('#btn-toast-dismiss').addEventListener('click', () => toast.remove());
  setTimeout(() => toast?.remove(), 5 * 60 * 1000);
}

function toggleAlarm() {
  lifeAlarmOn = !lifeAlarmOn;
  const btn = document.getElementById('btn-life-alarm');
  btn.textContent = lifeAlarmOn ? '🔔' : '🔕';
  btn.title = lifeAlarmOn ? 'Alarm on' : 'Alarm paused';
}
