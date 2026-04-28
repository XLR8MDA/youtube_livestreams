'use strict';

// ── State ─────────────────────────────────────────────────────────────────
let slLoaded = false; // fetch only on first activation (or manual refresh)

// ── Entry point ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initStreamLog);

function initStreamLog() {
  document.getElementById('btn-sl-refresh').addEventListener('click', () => {
    slLoaded = false;
    loadStreamLog();
  });
  document.getElementById('sl-days').addEventListener('change', loadStreamLog);
  document.getElementById('sl-channel').addEventListener('change', loadStreamLog);
}

// Called by backtest.js switchTab when stream-log tab is activated
function onStreamLogTabActivated() {
  populateSlChannelFilter();
  if (!slLoaded) loadStreamLog();
}

// ── Channel filter ────────────────────────────────────────────────────────
function populateSlChannelFilter() {
  const sel  = document.getElementById('sl-channel');
  const prev = sel.value;
  const list = (typeof channels !== 'undefined' ? channels : []);
  sel.innerHTML =
    '<option value="">All channels</option>' +
    list.map(ch =>
      `<option value="${slEscAttr(ch.channelId)}">${slEscHtml(ch.name || ch.handle || ch.channelId)}</option>`
    ).join('');
  if (prev) sel.value = prev;
}

// ── Fetch & render ────────────────────────────────────────────────────────
async function loadStreamLog() {
  const days      = document.getElementById('sl-days').value || '30';
  const channelId = document.getElementById('sl-channel').value || '';

  setSlStatus('loading');

  let grouped;
  try {
    let url = `/.netlify/functions/stream-log?days=${days}`;
    if (channelId) url += `&channelId=${encodeURIComponent(channelId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Stream log function not available locally. Restart `netlify dev` so `/.netlify/functions/stream-log` is mounted.');
      }
      throw new Error(`HTTP ${res.status}`);
    }
    grouped = await res.json();
  } catch (err) {
    setSlStatus('error', `Failed to load stream log: ${err.message}`);
    return;
  }

  slLoaded = true;

  if (!Array.isArray(grouped) || grouped.length === 0) {
    setSlStatus('empty', 'No streams found for the selected range.');
    return;
  }

  setSlStatus('hidden');
  renderDayGroups(grouped);
}

function setSlStatus(state, message) {
  const el      = document.getElementById('sl-status');
  const listEl  = document.getElementById('sl-days-list');

  if (state === 'hidden') {
    el.style.display   = 'none';
    listEl.style.display = '';
    return;
  }

  listEl.style.display = 'none';
  el.style.display     = '';

  const icons = { loading: '&#128203;', empty: '&#128203;', error: '&#9888;' };
  const texts = {
    loading: 'Loading stream log&hellip;',
    empty:   message || 'No streams found.',
    error:   message || 'An error occurred.',
  };

  el.innerHTML = `
    <div class="big-icon">${icons[state] || '&#128203;'}</div>
    <p>${texts[state]}</p>
  `;
}

// ── Day groups ────────────────────────────────────────────────────────────
function renderDayGroups(grouped) {
  const listEl = document.getElementById('sl-days-list');
  listEl.innerHTML = '';

  for (const { date, streams } of grouped) {
    const group = document.createElement('div');
    group.className = 'sl-day-group';

    const heading = document.createElement('div');
    heading.className = 'sl-day-heading';
    heading.textContent = formatDate(date);
    group.appendChild(heading);

    for (const entry of streams) {
      group.appendChild(renderStreamEntry(entry));
    }

    listEl.appendChild(group);
  }
}

// ── Stream card ───────────────────────────────────────────────────────────
function renderStreamEntry(entry) {
  const card = document.createElement('div');
  card.className = 'sl-entry';

  const initials = (entry.channelName || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?';
  const videoUrl = `https://www.youtube.com/watch?v=${entry.videoId}`;
  const timeStr  = entry.endedAt ? formatTime(entry.endedAt) : '';

  card.innerHTML = `
    <div class="sl-entry-header">
      <div class="sl-avatar">${slEscHtml(initials)}</div>
      <div class="sl-entry-info">
        <div class="sl-channel-name">${slEscHtml(entry.channelName || entry.channelId || '')}</div>
        ${entry.streamTitle ? `<div class="sl-stream-title">${slEscHtml(entry.streamTitle)}</div>` : ''}
      </div>
      <div class="sl-entry-meta">
        ${timeStr ? `<span class="sl-time">${timeStr}</span>` : ''}
        <span class="sl-status-badge ${slEscAttr(entry.status || 'pending')}">${statusLabel(entry.status)}</span>
        ${entry.markerCount > 0 ? `<span class="sl-marker-count">${entry.markerCount} marker${entry.markerCount !== 1 ? 's' : ''}</span>` : ''}
        <a class="sl-watch-link" href="${videoUrl}" target="_blank" rel="noopener">&#9654; Watch</a>
      </div>
    </div>
  `;

  if (Array.isArray(entry.markers) && entry.markers.length > 0) {
    card.appendChild(renderMarkers(entry.markers, entry.videoId));
  }

  return card;
}

// ── Marker chips ──────────────────────────────────────────────────────────
function renderMarkers(markers, videoId) {
  const wrap = document.createElement('div');
  wrap.className = 'sl-markers';

  for (const m of markers) {
    const tsStr = formatTs(m.ts);
    const url   = `https://www.youtube.com/watch?v=${videoId}&t=${m.ts}s`;
    const chip  = document.createElement('a');
    chip.className = `sl-marker-chip ${slEscAttr(m.type || 'discussion')}`;
    chip.href      = url;
    chip.target    = '_blank';
    chip.rel       = 'noopener';
    chip.title     = m.label;
    chip.innerHTML = `<span class="sl-chip-ts">${tsStr}</span> ${slEscHtml(m.label)}`;
    wrap.appendChild(chip);
  }

  return wrap;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatTs(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function statusLabel(status) {
  const labels = {
    'analyzed':      'Analyzed',
    'no-transcript': 'No Transcript',
    'error':         'Error',
    'pending':       'Pending',
  };
  return labels[status] || status || 'Unknown';
}

function slEscHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slEscAttr(str) {
  return String(str).replace(/[^a-zA-Z0-9-_]/g, '');
}
