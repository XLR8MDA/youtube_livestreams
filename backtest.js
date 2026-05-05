'use strict';

// ── State ─────────────────────────────────────────────────────────────────
let btPlayer             = null;   // YT.Player for backtest
let btChannelId          = null;
let btStreamId           = null;
let btStreamTitle        = null;
let btNextToken          = null;   // pagination token for past-streams
let btStreamMeta         = null;
let btShowOnlyUnreviewed = false;
let btReviewedIds        = new Set(); // synced from DB per channel

// ── Entry point ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initBacktest);

function initBacktest() {
  setupChannelSelect();
  setupLoadMore();
  setupManualUrl();
  setupRRCalc();
  setupJournalForm();
  setupJournalPairSelect();
  setupScreenshotPaste();
  setupReviewFilter();
}

// ── Reviewed streams (DB-backed) ──────────────────────────────────────────
async function loadReviewedIds(channelId) {
  try {
    const res  = await fetch(`/.netlify/functions/reviewed-streams?channelId=${encodeURIComponent(channelId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    btReviewedIds = new Set(data.videoIds || []);
  } catch (err) {
    console.warn('[reviewed-streams] load failed:', err.message);
    btReviewedIds = new Set();
  }
}

async function setStreamReviewed(videoId, reviewed) {
  if (reviewed) {
    btReviewedIds.add(videoId);
    await fetch('/.netlify/functions/reviewed-streams', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ videoId, channelId: btChannelId }),
    }).catch(() => {});
  } else {
    btReviewedIds.delete(videoId);
    await fetch(
      `/.netlify/functions/reviewed-streams?videoId=${encodeURIComponent(videoId)}&channelId=${encodeURIComponent(btChannelId)}`,
      { method: 'DELETE' }
    ).catch(() => {});
  }
}

function isStreamReviewed(videoId) {
  return btReviewedIds.has(videoId);
}

function setupReviewFilter() {
  const btn = document.getElementById('btn-filter-reviewed');
  btn.addEventListener('click', () => {
    btShowOnlyUnreviewed = !btShowOnlyUnreviewed;
    btn.classList.toggle('active', btShowOnlyUnreviewed);
    btn.textContent = btShowOnlyUnreviewed ? 'Show all' : 'Hide done';
    applyReviewFilter();
  });
}

function applyReviewFilter() {
  document.querySelectorAll('#backtest-stream-list .stream-card').forEach(card => {
    const hidden = btShowOnlyUnreviewed && card.classList.contains('reviewed');
    card.style.display = hidden ? 'none' : '';
  });
}


// ── Channel selector ──────────────────────────────────────────────────────
function populateChannelSelect() {
  const sel = document.getElementById('backtest-channel-select');
  const prev = sel.value;
  // `channels` is the global array from app.js
  const list = (typeof channels !== 'undefined' ? channels : []);
  sel.innerHTML =
    '<option value="">Select a channel</option>' +
    list.map(ch =>
      `<option value="${btEscAttr(ch.channelId)}">${btEscHtml(ch.name || ch.handle || ch.channelId)}</option>`
    ).join('');
  if (prev) sel.value = prev;
}

function setupChannelSelect() {
  document.getElementById('backtest-channel-select').addEventListener('change', async e => {
    btChannelId = e.target.value || null;
    btNextToken = null;
    btReviewedIds = new Set();
    clearStreamList();
    resetPlayer();
    clearJournal();
    if (btChannelId) {
      await Promise.all([
        loadReviewedIds(btChannelId),
        loadPastStreams(btChannelId, null),
      ]);
    }
  });
}

// ── Manual URL Loader ─────────────────────────────────────────────────────
function setupManualUrl() {
  const input  = document.getElementById('manual-url-input');
  const btn    = document.getElementById('btn-manual-url-load');
  const status = document.getElementById('manual-url-status');

  function tryLoad() {
    const raw = input.value.trim();
    if (!raw) return;
    const videoId = extractVideoIdFromUrl(raw);
    if (!videoId) {
      status.textContent = 'Could not find a video ID in that URL.';
      status.style.display = '';
      return;
    }
    status.style.display = 'none';
    input.value = '';
    selectStream({ videoId, title: videoId, publishedAt: null, thumbnail: null });
  }

  btn.addEventListener('click', tryLoad);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryLoad(); });
}

function extractVideoIdFromUrl(url) {
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/live\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  if (/^[\w-]{11}$/.test(url)) return url; // bare video ID
  return null;
}

// ── Past streams list ─────────────────────────────────────────────────────
function clearStreamList() {
  document.getElementById('backtest-stream-list').innerHTML = '';
  document.getElementById('stream-list-status').textContent = btChannelId ? 'Loading…' : 'No channel selected.';
  document.getElementById('stream-list-status').style.display = '';
  document.getElementById('btn-load-more-streams').classList.add('hidden');
}

async function loadPastStreams(channelId, pageToken) {
  const status = document.getElementById('stream-list-status');
  status.textContent = 'Loading…';
  status.style.display = '';

  let url = `/.netlify/functions/past-streams?channelId=${encodeURIComponent(channelId)}`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

  try {
    const res  = await fetch(url);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Function error (HTTP ${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const { streams, nextPageToken } = data;
    btNextToken = nextPageToken || null;

    if (!streams.length && !pageToken) {
      status.textContent = 'No completed livestreams found for this channel.';
      return;
    }

    status.style.display = 'none';
    appendStreamCards(streams);
    document.getElementById('btn-load-more-streams').classList.toggle('hidden', !btNextToken);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

function appendStreamCards(streams) {
  const list = document.getElementById('backtest-stream-list');
  for (const s of streams) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'stream-card';
    card.dataset.videoId = s.videoId;
    if (isStreamReviewed(s.videoId)) card.classList.add('reviewed');
    const parsed = s.publishedAt ? new Date(s.publishedAt) : null;
    const date   = parsed && !isNaN(parsed)
      ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : (s.publishedAt || '');
    card.innerHTML = `
      ${s.thumbnail ? `<img class="stream-card-thumb" src="${btEscAttr(s.thumbnail)}" alt="">` : ''}
      <div class="stream-card-info">
        <div class="stream-card-title">${btEscHtml(s.title)}</div>
        <div class="stream-card-date">${date}</div>
      </div>
      <button class="stream-card-tick" title="Mark as reviewed" type="button">✓</button>
      <span class="stream-card-action">Load</span>
    `;
    card.querySelector('.stream-card-tick').addEventListener('click', async e => {
      e.stopPropagation();
      const nowReviewed = !isStreamReviewed(s.videoId);
      card.classList.toggle('reviewed', nowReviewed);
      applyReviewFilter();
      await setStreamReviewed(s.videoId, nowReviewed);
    });
    card.addEventListener('click', () => selectStream(s));
    list.appendChild(card);
  }
  applyReviewFilter();
}

function setupLoadMore() {
  document.getElementById('btn-load-more-streams').addEventListener('click', async () => {
    if (btChannelId && btNextToken) await loadPastStreams(btChannelId, btNextToken);
  });
}

// ── Player ────────────────────────────────────────────────────────────────
function selectStream(stream) {
  const { videoId, title } = stream;

  document.querySelectorAll('.stream-card').forEach(c =>
    c.classList.toggle('active', c.dataset.videoId === videoId)
  );

  btStreamId    = videoId;
  btStreamTitle = title;
  btStreamMeta  = stream;

  document.getElementById('backtest-player-title').textContent = title;
  document.getElementById('backtest-player-empty').classList.add('hidden');
  document.getElementById('backtest-player-frame').classList.remove('hidden');
  document.getElementById('journal-context').textContent = `Logging for: ${title}`;
  renderPlayerMeta(stream);

  if (btPlayer) {
    btPlayer.loadVideoById(videoId);
  } else {
    btPlayer = new YT.Player('backtest-player', {
      videoId,
      playerVars: { controls: 1, rel: 0, modestbranding: 1 },
    });
  }

  if (btChannelId) {
    loadJournalEntries(btChannelId, videoId);
  }
}

function resetPlayer() {
  btStreamId    = null;
  btStreamTitle = null;
  btStreamMeta  = null;
  document.getElementById('backtest-player-title').textContent = 'No stream selected';
  document.getElementById('backtest-player-empty').classList.remove('hidden');
  document.getElementById('backtest-player-frame').classList.add('hidden');
  document.getElementById('player-meta').innerHTML = '';
  if (btPlayer) {
    try { btPlayer.destroy(); } catch {}
    btPlayer = null;
  }
}

function renderPlayerMeta(stream) {
  const meta = document.getElementById('player-meta');
  const parts = [];

  if (stream?.publishedAt) {
    const date = new Date(stream.publishedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    parts.push(`<span>${btEscHtml(date)}</span>`);
  }

  meta.innerHTML = parts.join('');
}


// ── Journal Pair Select ───────────────────────────────────────────────────
function populatePairSelect() {
  const sel  = document.getElementById('trade-pair');
  const prev = sel.value;
  const all  = [
    ...(typeof DEFAULT_PAIRS !== 'undefined' ? DEFAULT_PAIRS : []),
    ...(typeof customPairs   !== 'undefined' ? customPairs   : []),
  ];
  sel.innerHTML =
    '<option value="">— Select pair —</option>' +
    all.map(p => `<option value="${btEscAttr(p.value)}">${btEscHtml(p.label)}</option>`).join('');
  if (prev) sel.value = prev;
}

function setupJournalPairSelect() {
  const addBtn     = document.getElementById('btn-add-trade-pair');
  const addRow     = document.getElementById('trade-pair-add-row');
  const cancelBtn  = document.getElementById('btn-cancel-trade-pair');
  const confirmBtn = document.getElementById('btn-confirm-trade-pair');
  const labelIn    = document.getElementById('trade-pair-label-in');
  const valueIn    = document.getElementById('trade-pair-value-in');

  addBtn.addEventListener('click', () => {
    addRow.classList.toggle('hidden');
    if (!addRow.classList.contains('hidden')) labelIn.focus();
  });

  cancelBtn.addEventListener('click', () => {
    addRow.classList.add('hidden');
    labelIn.value = '';
    valueIn.value = '';
  });

  confirmBtn.addEventListener('click', async () => {
    const label = labelIn.value.trim();
    const value = valueIn.value.trim().toUpperCase();
    if (!label || !value) { btShowToast('Enter both label and symbol', 'error'); return; }

    if (typeof addCustomPair === 'function') {
      await addCustomPair(label, value);
    }

    populatePairSelect();
    document.getElementById('trade-pair').value = value;
    addRow.classList.add('hidden');
    labelIn.value = '';
    valueIn.value = '';
    btShowToast(`Pair "${label}" added`, 'success');
  });

  [labelIn, valueIn].forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') confirmBtn.click();
      if (e.key === 'Escape') cancelBtn.click();
    });
  });
}

// ── R:R auto-calc ─────────────────────────────────────────────────────────
function setupRRCalc() {
  ['trade-entry', 'trade-exit', 'trade-stop', 'trade-result'].forEach(id => {
    document.getElementById(id).addEventListener('input', calcRR);
    if (id === 'trade-result') document.getElementById(id).addEventListener('change', calcRR);
  });
}

function calcRR() {
  const result = document.getElementById('trade-result').value;
  const rrEl   = document.getElementById('trade-rr');

  if (result === 'loss') {
    rrEl.value = '-1.00';
    return;
  }
  if (result === 'be') {
    rrEl.value = '0.00';
    return;
  }

  const entry = parseFloat(document.getElementById('trade-entry').value);
  const exit  = parseFloat(document.getElementById('trade-exit').value);
  const stop  = parseFloat(document.getElementById('trade-stop').value);

  if (!isNaN(entry) && !isNaN(exit) && !isNaN(stop) && stop !== entry) {
    const raw = (exit - entry) / (entry - stop);
    // If user marked 'win' but math is negative, it's probably a wrong setup, but we'll show absolute RR as a "gain" multiple.
    // However, the cleanest is just (exit-entry)/(entry-stop).
    rrEl.value = Math.max(0, raw).toFixed(2);
  } else {
    rrEl.value = '';
  }
}

// ── Journal form ──────────────────────────────────────────────────────────
function setupJournalForm() {
  document.getElementById('journal-form').addEventListener('submit', async e => {
    e.preventDefault();

    if (!btChannelId || !btStreamId) {
      btShowToast('Select a stream first', 'error');
      return;
    }

    const btn = document.getElementById('btn-save-trade');
    btn.disabled = true;

    // Capture current video timestamp automatically
    let videoTimestamp = null;
    try {
      if (btPlayer && btPlayer.getCurrentTime) {
        videoTimestamp = Math.floor(btPlayer.getCurrentTime());
      }
    } catch {}
    const manualTs = document.getElementById('trade-timestamp').value;
    if (manualTs !== '') videoTimestamp = parseInt(manualTs, 10);

    const entry = {
      pair:           document.getElementById('trade-pair').value.trim() || null,
      direction:      document.getElementById('trade-direction').value,
      result:         document.getElementById('trade-result').value,
      entry:          parseFloat(document.getElementById('trade-entry').value) || null,
      exit:           parseFloat(document.getElementById('trade-exit').value)  || null,
      stop:           parseFloat(document.getElementById('trade-stop').value)  || null,
      rr:             parseFloat(document.getElementById('trade-rr').value)    || null,
      notes:          document.getElementById('trade-notes').value.trim(),
      videoTimestamp,
    };

    try {
      const res = await fetch('/.netlify/functions/journal', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          channelId:   btChannelId,
          streamId:    btStreamId,
          streamTitle: btStreamTitle,
          streamDate:  btStreamMeta?.publishedAt || null,
          entry,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      btShowToast('Trade saved', 'success');
      document.getElementById('journal-form').reset();
      // Auto-mark stream as reviewed when a trade is logged
      btReviewedIds.add(btStreamId);
      document.querySelectorAll(`.stream-card[data-video-id="${btStreamId}"]`).forEach(c => {
        c.classList.add('reviewed');
      });
      applyReviewFilter();
      await loadJournalEntries(btChannelId, btStreamId);
    } catch (err) {
      btShowToast(`Save failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Journal entries ───────────────────────────────────────────────────────
function clearJournal() {
  document.getElementById('journal-entries').innerHTML = '';
  document.getElementById('journal-status').textContent = 'No stream selected.';
  document.getElementById('journal-status').style.display = '';
  document.getElementById('journal-context').textContent = 'Load a stream before logging a trade.';
}

async function loadJournalEntries(channelId, streamId) {
  const status    = document.getElementById('journal-status');
  const container = document.getElementById('journal-entries');
  status.textContent = 'Loading…';
  status.style.display = '';
  container.innerHTML  = '';

  try {
    const res     = await fetch(`/.netlify/functions/journal?channelId=${encodeURIComponent(channelId)}&streamId=${encodeURIComponent(streamId)}`);
    const entries = await res.json();
    if (!res.ok) throw new Error(entries.error || `HTTP ${res.status}`);

    if (!entries.length) {
      status.textContent = 'No trades logged for this stream yet.';
      return;
    }
    status.style.display = 'none';
    renderJournalEntries(entries, channelId, streamId);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

function renderJournalEntries(entries, channelId, streamId) {
  const container = document.getElementById('journal-entries');
  container.innerHTML = '';

  // Show newest first
  [...entries].reverse().forEach(e => {
    const el  = document.createElement('div');
    el.className  = `journal-entry result-${e.result}`;
    const ts  = e.videoTimestamp != null ? ` @${fmtTime(e.videoTimestamp)}` : '';
    el.innerHTML = `
      <div class="je-header">
        ${e.pair ? `<span class="je-pair">${btEscHtml(e.pair)}</span>` : ''}
        <span class="je-direction ${e.direction}">${e.direction.toUpperCase()}</span>
        <span class="je-result ${e.result}">${e.result.toUpperCase()}</span>
        ${e.rr   ? `<span class="je-rr">${e.rr}R</span>` : ''}
        ${ts     ? `<span class="je-ts">${btEscHtml(ts)}</span>` : ''}
        <button class="je-delete" title="Delete">&times;</button>
      </div>
      ${e.notes ? `<div class="je-notes">${btEscHtml(e.notes)}</div>` : ''}
    `;
    el.querySelector('.je-delete').addEventListener('click', () =>
      deleteJournalEntry(channelId, streamId, e.id)
    );
    container.appendChild(el);
  });
}

async function deleteJournalEntry(channelId, streamId, entryId) {
  try {
    const res = await fetch(
      `/.netlify/functions/journal?channelId=${encodeURIComponent(channelId)}&streamId=${encodeURIComponent(streamId)}&entryId=${encodeURIComponent(entryId)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    btShowToast('Entry deleted', 'info');
    await loadJournalEntries(channelId, streamId);
  } catch (err) {
    btShowToast(`Delete failed: ${err.message}`, 'error');
  }
}


// ── Screenshot auto-fill ─────────────────────────────────────────────────
function setupScreenshotPaste() {
  const dropArea = document.getElementById('screenshot-drop-area');
  const clearBtn = document.getElementById('btn-clear-screenshot');

  // Drag-and-drop
  dropArea.addEventListener('dragover', e => {
    e.preventDefault();
    dropArea.classList.add('drag-over');
  });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
  dropArea.addEventListener('drop', e => {
    e.preventDefault();
    dropArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) processScreenshot(file);
  });

  // Upload button — opens file picker (works on mobile)
  const fileInput = document.getElementById('screenshot-file-input');
  document.getElementById('btn-upload-screenshot').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) { processScreenshot(file); fileInput.value = ''; }
  });

  // Global paste listener
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { processScreenshot(file); break; }
      }
    }
  });

  clearBtn.addEventListener('click', clearScreenshot);
}

function clearScreenshot() {
  document.getElementById('screenshot-preview').classList.add('hidden');
  document.getElementById('screenshot-drop-area').classList.remove('hidden');
  const status = document.getElementById('screenshot-status');
  status.textContent = '';
  status.className = 'screenshot-status hidden';
  document.getElementById('screenshot-img').src = '';
}

async function processScreenshot(file) {
  const dropArea = document.getElementById('screenshot-drop-area');
  const preview  = document.getElementById('screenshot-preview');
  const img      = document.getElementById('screenshot-img');
  const status   = document.getElementById('screenshot-status');

  // Show preview immediately
  img.src = URL.createObjectURL(file);
  dropArea.classList.add('hidden');
  preview.classList.remove('hidden');
  status.textContent = 'Extracting trade details…';
  status.className   = 'screenshot-status extracting';

  try {
    const base64 = await fileToBase64(file);

    const existingPairs = [
      ...(typeof DEFAULT_PAIRS !== 'undefined' ? DEFAULT_PAIRS : []),
      ...(typeof customPairs   !== 'undefined' ? customPairs   : []),
    ];

    const res = await fetch('/.netlify/functions/extract-trade', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ imageBase64: base64, mimeType: file.type, pairs: existingPairs }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    fillFormFromExtraction(data, existingPairs);
    status.textContent = 'Details extracted — review and tweak before saving.';
    status.className   = 'screenshot-status success';
  } catch (err) {
    status.textContent = `Extraction failed: ${err.message}`;
    status.className   = 'screenshot-status error';
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fillFormFromExtraction(data, existingPairs) {
  const { pair, entry, stop, exit, direction, notes } = data;

  // Pair — match existing or open the add-pair row pre-filled
  if (pair) {
    const sel   = document.getElementById('trade-pair');
    const match = existingPairs.find(p => p.value.toUpperCase() === pair.toUpperCase());
    if (match) {
      sel.value = match.value;
    } else {
      document.getElementById('trade-pair-label-in').value = pair;
      document.getElementById('trade-pair-value-in').value = pair.toUpperCase();
      document.getElementById('trade-pair-add-row').classList.remove('hidden');
      btShowToast(`Pair "${pair}" not in list — confirm to add it`, 'info');
    }
  }

  if (direction) {
    document.getElementById('trade-direction').value = direction;
  }

  if (entry != null) document.getElementById('trade-entry').value = entry;
  if (exit  != null) document.getElementById('trade-exit').value  = exit;
  if (stop  != null) document.getElementById('trade-stop').value  = stop;

  if (notes) {
    const notesEl = document.getElementById('trade-notes');
    if (!notesEl.value) notesEl.value = notes;
  }

  calcRR();
  btShowToast('Form filled from screenshot', 'success');
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function btEscHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function btEscAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// Use the toast from app.js if available, otherwise log
function btShowToast(msg, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(msg, type);
  } else {
    console.log(`[${type}] ${msg}`);
  }
}
