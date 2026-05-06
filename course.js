'use strict';

// Hardcoded video IDs — no API calls needed
const COURSE_VIDEOS = {
  smc: [
    { videoId: '1cCUunzQ-V4', title: 'What is Smart Money Concept? (SMC Explained) | Part 1' }, // 0
    { videoId: 'Th6YxswUOh4', title: 'Market Structure Mastery (BOS & CHoCH Explained) Part 2' }, // 1
    { videoId: 'sTKIlbeKPpg', title: 'Advanced Liquidity & Manipulation: The Smart Money Play (Stop Hunts & Liquidity Pools) Part 3' }, // 2
    { videoId: 'hGTuhomD0B4', title: 'Advanced FVGs (Consecutive & Overlapping Imbalances) Part 4' }, // 3
    { videoId: 'J9cvlJk4w8U', title: 'ICT OTE Strategy – Trade Like Smart Money | Part 5' }, // 4
    { videoId: '3DxYFR-MD0w', title: 'Inducement: The Trap Before the Big Move (Explained) Part 6' }, // 5
    { videoId: 'TX0nhBMrT4U', title: 'Top Down Analysis SMC Strategy | Best Price Action Method (Step by Step) Part 7' }, // 6
    { videoId: 'mLU_C4NG4Gw', title: 'Momentum Sniper Strategy (MSM) – My Personal Forex Edge Revealed | Part 8' }, // 7
    { videoId: 'ZErwnATeeuU', title: 'How to Mark POI Levels Like Smart Money (SMC) Part 9' }, // 8
    { videoId: 't4TYgi-XxKM', title: 'SMC Order Flow Explained – How Smart Money Really Trades (Part 10)' }, // 9
  ],
  bootcamp: [
    { videoId: 'k9li2a0qn5I', title: 'Master Price Action - Bootcamp Ep.1' }, // 0
    { videoId: 'YxMMov8roBQ', title: 'Market Structure: The Skill That Separates Winners - Bootcamp Ep.2' }, // 1
    { videoId: 'vCh4so18bDg', title: 'Supply & Demand - Bootcamp Ep.3' }, // 2
    { videoId: 'D6svZ1whG7U', title: 'Imbalance - Bootcamp Ep.4' }, // 3
    { videoId: 'YYW3yPfyHpg', title: 'Efficient Ranges - Bootcamp Ep.5' }, // 4
    { videoId: '-UIrmQ3y0nI', title: 'Equal High & Equal Low Liquidity - Bootcamp Ep.6' }, // 5
    { videoId: 'qErVtn3NBbQ', title: 'Trend Liquidity - Bootcamp Ep.7' }, // 6
    { videoId: '4YQnt5FEP4g', title: 'How to read Candle Momentum - Bootcamp Ep.8' }, // 7
    { videoId: '2iVkF_FVCXA', title: 'Reading markets with \'Multi-Candle\' Momentum - Bootcamp Ep.9' }, // 8
    { videoId: 'mFmEkEEKJQE', title: 'What timeframes should you trade? - Bootcamp 10' }, // 9
    { videoId: 'xIbYGU318j0', title: 'How to Day Trade London & NY Session - Bootcamp Ep.11' }, // 10
    { videoId: 'ewZVjxk0SlY', title: 'Markets Tell a Story... Here\'s How You Read It - Bootcamp Ep.12' }, // 11
  ],
  zip3: [
    { videoId: 'ygleB1CLhUE', title: 'Master Market Structure in 68 Minutes (Step-by-Step Course)' }, // 0
    { videoId: '0kl47rZZ4SQ', title: 'The Stop Loss Strategy That Can 10X Your Profits' }, // 1
    { videoId: '4Ymh5Rvm0C8', title: 'This entry model will change how you trade… (10x results)' }, // 2
    { videoId: 'IHH_eKHt9uo', title: 'How to trade REVERSALS - Full Course' }, // 3
    { videoId: 'RvO3iQjXui0', title: 'How to trade continuations - Full Course' }, // 4
    { videoId: 'JhBX0TQ41H8', title: 'Liquidity + Structure = Profit' }, // 5
    { videoId: 'Z4Y301e_udQ', title: 'How to Trade Reversals' }, // 6
    { videoId: 'jWKT-P9pPdc', title: 'Complete Guide to Market Structure (Mastery)' }, // 7
    { videoId: 'LclxDYccla8', title: 'The ONLY Market Structure Lesson You\'ll EVER Need (Step by Step)' }, // 8
    { videoId: 'BNVGhjxP4JY', title: 'Market Structure Masterclass' }, // 9
    { videoId: 'LSs9femocqc', title: 'How To Trade Market Structure On Any Timeframe | (Structure Layers) - JeaFx' }, // 10
    { videoId: '8QZ1AnUQHho', title: 'Different Types of Structure | Which One Should You Use? - JeaFx' }, // 11
  ],
};

const COURSE_STORAGE_KEY = 'course_completed';
const COURSE_NOTES_KEY = 'course_notes';

const PHASES = [
  {
    id: 1,
    label: 'Phase 1',
    title: 'Price Action & Market Structure Foundations',
    weeks: 'Week 1-2',
    lessons: [
      { n: 1, title: 'What is price action? - raw price, no indicators, candlestick basics', source: 'bootcamp', vIdx: 0 },
      { n: 2, title: 'Candlestick bodies vs wicks - confirmed vs rejected price', source: 'bootcamp', vIdx: 0 },
      { n: 3, title: 'Market structure basics - HH, HL, LH, LL, identifying trend direction', source: 'bootcamp', vIdx: 1 },
      { n: 4, title: 'Impulse vs corrective moves - pro-trend vs pullback, why they happen', source: 'bootcamp', vIdx: 1 },
      { n: 5, title: 'Swing structure vs substructure - layers of structure across timeframes', source: 'zip3', vIdx: 0 },
      { n: 6, title: 'Market structure in SMC context - BOS, CHoCH, HH/HL with examples', source: 'smc', vIdx: 1 },
    ],
  },
  {
    id: 2,
    label: 'Phase 2',
    title: 'Supply, Demand & Liquidity',
    weeks: 'Week 3-4',
    lessons: [
      { n: 7, title: 'Supply and demand theory - why prices appreciate and depreciate', source: 'bootcamp', vIdx: 2 },
      { n: 8, title: 'Identifying supply and demand zones - consolidation before large moves', source: 'bootcamp', vIdx: 2 },
      { n: 9, title: 'What is liquidity? - orders and money, where it builds and why', source: 'bootcamp', vIdx: 5 },
      { n: 10, title: 'Liquidity in SMC context - smart money hunts liquidity before moving', source: 'smc', vIdx: 2 },
      { n: 11, title: 'Equal highs and equal lows - stop-loss clusters, how large players hunt them', source: 'bootcamp', vIdx: 5 },
      { n: 12, title: 'Trend liquidity - liquidity along trend lines, retail traps', source: 'bootcamp', vIdx: 6 },
      { n: 13, title: 'Stop hunts and manipulation - advanced liquidity sweeps, fake breakouts', source: 'smc', vIdx: 2 },
      { n: 14, title: 'Liquidity plus structure combined - entry model using sweeps plus BOS', source: 'zip3', vIdx: 5 },
    ],
  },
  {
    id: 3,
    label: 'Phase 3',
    title: 'Imbalance, FVG & Order Blocks',
    weeks: 'Week 5-6',
    lessons: [
      { n: 15, title: 'Imbalance theory - open price ranges, magnet areas, filling theory', source: 'bootcamp', vIdx: 3 },
      { n: 16, title: 'Efficient vs inefficient ranges - filled vs unfilled imbalances', source: 'bootcamp', vIdx: 4 },
      { n: 17, title: 'Fair Value Gap basics - 3-candle method, bullish and bearish FVG', source: 'smc', vIdx: 3 },
      { n: 18, title: 'Advanced FVGs - consecutive and overlapping imbalances', source: 'smc', vIdx: 3 },
      { n: 19, title: 'Order blocks (POI) - institutional zones, how to mark them', source: 'smc', vIdx: 8 },
      { n: 20, title: 'Point of Interest levels - support, resistance, FVG, OB as trade zones', source: 'smc', vIdx: 8 },
    ],
  },
  {
    id: 4,
    label: 'Phase 4',
    title: 'Momentum, Entries & Trade Management',
    weeks: 'Week 7-9',
    lessons: [
      { n: 21, title: 'Individual candle momentum - reading the buy and sell battle inside candles', source: 'bootcamp', vIdx: 7 },
      { n: 22, title: 'Multi-candle momentum - size, speed, smoothness across candle series', source: 'bootcamp', vIdx: 8 },
      { n: 23, title: 'OTE - optimal trade entry - Fibonacci 0.62 to 0.79, premium vs discount', source: 'smc', vIdx: 4 },
      { n: 24, title: 'Inducement - fake CHoCH, real vs false structure shifts', source: 'smc', vIdx: 5 },
      { n: 25, title: 'Confirmation entry model - BOS plus demand pullback, candle closure rule', source: 'zip3', vIdx: 2 },
      { n: 26, title: 'Reversal trading - entry model, context, supply and demand plus key levels', source: 'zip3', vIdx: 3 },
      { n: 27, title: 'Continuation trading - risk entry vs fractal confirmation, riding trends', source: 'zip3', vIdx: 4 },
      { n: 28, title: 'Stop loss trailing - structure-based SL trailing, win-win scenarios', source: 'zip3', vIdx: 1 },
    ],
  },
  {
    id: 5,
    label: 'Phase 5',
    title: 'Full Strategy & Market Reading',
    weeks: 'Week 10-12',
    lessons: [
      { n: 29, title: 'Top-down analysis - HTF bias to MTF POI to LTF entry execution', source: 'smc', vIdx: 6 },
      { n: 30, title: 'Order flow - reading market flow direction, post-CHoCH POI', source: 'smc', vIdx: 9 },
      { n: 31, title: 'Momentum Sniper Method (MSM) - full strategy: structure plus OTE plus FVG', source: 'smc', vIdx: 7 },
      { n: 32, title: 'Fractal market nature - same concepts on every timeframe', source: 'bootcamp', vIdx: 9 },
      { n: 33, title: 'Sessions and day trading - Asia, London, NY session timing and characteristics', source: 'bootcamp', vIdx: 10 },
      { n: 34, title: 'Reading market narrative - combining all concepts to read chart stories', source: 'bootcamp', vIdx: 11 },
    ],
  },
];

let coursePlayer = null;
let courseLoaded = false;
let coursePlaylists = {};
let activePhaseId = 1;
let activeLessonNumber = null;

document.addEventListener('DOMContentLoaded', initCourse);

function initCourse() {
  const markBtn = document.getElementById('btn-course-mark-complete');
  if (markBtn) {
    markBtn.addEventListener('click', () => {
      if (activeLessonNumber != null) toggleComplete(activeLessonNumber);
    });
  }

  const notesInput = document.getElementById('course-notes-input');
  if (notesInput) {
    notesInput.addEventListener('input', () => {
      if (activeLessonNumber != null) saveNote(activeLessonNumber, notesInput.value);
    });
  }
}

function onCourseTabActivated() {
  if (!courseLoaded) loadCourse();
}

async function loadCourse() {
  setCourseStatus('loading');
  try {
    // Hardcoded course data is used instead of API calls
    coursePlaylists = COURSE_VIDEOS;
    courseLoaded = true;
    setCourseStatus('ready');
    renderSidebar();
    renderLessons(activePhaseId);
  } catch (err) {
    setCourseStatus('error', err.message || 'Unknown error');
  }
}

function setCourseStatus(state, message = '') {
  const statusEl = document.getElementById('course-status');
  const contentEl = document.getElementById('course-content');
  if (!statusEl || !contentEl) return;

  if (state === 'ready') {
    statusEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
    return;
  }

  statusEl.classList.remove('hidden');
  contentEl.classList.add('hidden');

  const icon = state === 'error' ? '&#9888;' : '&#128218;';
  const text = state === 'error' ? `Failed to load: ${escapeHtml(message)}` : 'Loading course&hellip;';
  statusEl.innerHTML = `<div class="course-status-icon">${icon}</div><p>${text}</p>`;
}

function renderSidebar() {
  const nav = document.getElementById('course-phase-nav');
  if (!nav) return;

  const completed = getCompletedLessons();
  const totalLessons = PHASES.reduce((sum, phase) => sum + phase.lessons.length, 0);
  const doneLessons = PHASES.flatMap(phase => phase.lessons).filter(lesson => completed.has(lesson.n)).length;
  const overallPercent = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0;

  nav.innerHTML = '';

  const overall = document.createElement('div');
  overall.className = 'course-overall-progress';
  overall.innerHTML = `
    <div class="course-overall-label">${doneLessons} / ${totalLessons} lessons</div>
    <div class="course-progress-bar"><div class="course-progress-fill" style="width:${overallPercent}%"></div></div>
  `;
  nav.appendChild(overall);

  for (const phase of PHASES) {
    const done = phase.lessons.filter(lesson => completed.has(lesson.n)).length;
    const total = phase.lessons.length;
    const percent = total ? Math.round((done / total) * 100) : 0;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `course-phase-btn${phase.id === activePhaseId ? ' active' : ''}`;
    button.innerHTML = `
      <div class="course-phase-btn-top">
        <span class="course-phase-label">${escapeHtml(phase.label)}</span>
        <span class="course-phase-count">${done}/${total}</span>
      </div>
      <div class="course-phase-title">${escapeHtml(phase.title)}</div>
      <div class="course-phase-bar"><div class="course-phase-fill" style="width:${percent}%"></div></div>
    `;
    button.addEventListener('click', () => {
      activePhaseId = phase.id;
      renderSidebar();
      renderLessons(phase.id);
    });
    nav.appendChild(button);
  }
}

function renderLessons(phaseId) {
  const phase = PHASES.find(item => item.id === phaseId);
  const list = document.getElementById('course-lesson-list');
  if (!phase || !list) return;

  const completed = getCompletedLessons();
  const heading = document.getElementById('course-phase-heading');
  const weeks = document.getElementById('course-phase-weeks');
  if (heading) heading.textContent = `${phase.label} - ${phase.title}`;
  if (weeks) weeks.textContent = phase.weeks;

  list.innerHTML = '';

  for (const lesson of phase.lessons) {
    const video = resolveVideo(lesson);
    const row = document.createElement('div');
    row.className = 'course-lesson-row';
    row.dataset.lessonNumber = String(lesson.n);

    if (completed.has(lesson.n)) row.classList.add('done');
    if (lesson.n === activeLessonNumber) row.classList.add('active');

    row.innerHTML = `
      <div class="course-lesson-num">${lesson.n}</div>
      <div class="course-lesson-body">
        <div class="course-lesson-title">${escapeHtml(lesson.title)}</div>
        <div class="course-lesson-meta">
          ${video ? '' : '<span class="course-no-video">video not found</span>'}
        </div>
      </div>
      <div class="course-lesson-actions">
        <button class="course-tick-btn${completed.has(lesson.n) ? ' done' : ''}" type="button" title="${completed.has(lesson.n) ? 'Mark incomplete' : 'Mark complete'}">&#10003;</button>
        ${video ? '<button class="course-watch-btn" type="button">Watch</button>' : ''}
      </div>
    `;

    const tickBtn = row.querySelector('.course-tick-btn');
    tickBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleComplete(lesson.n);
    });

    if (video) {
      const watchBtn = row.querySelector('.course-watch-btn');
      watchBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        playLesson(lesson, video);
      });
      row.addEventListener('click', () => playLesson(lesson, video));
    }

    list.appendChild(row);
  }
}

function resolveVideo(lesson) {
  const items = coursePlaylists[lesson.source] || [];
  if (lesson.vIdx !== undefined) return items[lesson.vIdx] || null;
  return items.find(item => item.title.includes(lesson.title.slice(0, 20))) || null;
}

function playLesson(lesson, video) {
  activeLessonNumber = lesson.n;

  document.querySelectorAll('.course-lesson-row').forEach((row) => {
    row.classList.toggle('active', Number(row.dataset.lessonNumber) === lesson.n);
  });

  const playerShell = document.getElementById('course-player-shell');
  if (playerShell) playerShell.classList.remove('course-player-empty-state');

  updateMarkButton();

  if (coursePlayer) {
    coursePlayer.loadVideoById(video.videoId);
    return;
  }

  coursePlayer = new YT.Player('course-yt-player', {
    videoId: video.videoId,
    playerVars: { controls: 1, rel: 0, modestbranding: 1 },
    events: {
      onStateChange: handlePlayerStateChange,
    },
  });
}

function handlePlayerStateChange(event) {
  if (event.data !== 0 || activeLessonNumber == null) return;

  const completed = getCompletedLessons();
  if (completed.has(activeLessonNumber)) return;

  completed.add(activeLessonNumber);
  saveCompletedLessons(completed);
  renderSidebar();
  renderLessons(activePhaseId);
  updateMarkButton();
  if (typeof showToast === 'function') showToast('Lesson marked complete', 'success');
}

function toggleComplete(lessonNumber) {
  const completed = getCompletedLessons();
  if (completed.has(lessonNumber)) {
    completed.delete(lessonNumber);
  } else {
    completed.add(lessonNumber);
  }

  saveCompletedLessons(completed);
  renderSidebar();
  renderLessons(activePhaseId);
  updateMarkButton();
}

function updateMarkButton() {
  const markBtn = document.getElementById('btn-course-mark-complete');
  if (!markBtn) return;

  if (activeLessonNumber == null) {
    markBtn.textContent = 'Mark Complete';
    markBtn.classList.remove('done');
    markBtn.disabled = true;
    return;
  }

  const completed = getCompletedLessons();
  const isDone = completed.has(activeLessonNumber);
  markBtn.disabled = false;
  markBtn.textContent = isDone ? 'Completed' : 'Mark Complete';
  markBtn.classList.toggle('done', isDone);
}

function getCompletedLessons() {
  try {
    const raw = JSON.parse(localStorage.getItem(COURSE_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

function saveCompletedLessons(completed) {
  localStorage.setItem(COURSE_STORAGE_KEY, JSON.stringify([...completed].sort((a, b) => a - b)));
}

function getNote(lessonNumber) {
  try {
    const notes = JSON.parse(localStorage.getItem(COURSE_NOTES_KEY) || '{}');
    return notes[lessonNumber] || '';
  } catch {
    return '';
  }
}

function saveNote(lessonNumber, text) {
  try {
    const notes = JSON.parse(localStorage.getItem(COURSE_NOTES_KEY) || '{}');
    notes[lessonNumber] = text;
    localStorage.setItem(COURSE_NOTES_KEY, JSON.stringify(notes));
  } catch (err) {
    console.error('Failed to save note:', err);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

