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
let btMarkers            = [];

// ── Entry point ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initBacktest);

function initBacktest() {
  setupTabs();
  setupSourceToggle();
  setupChannelSelect();
  setupLoadMore();
  setupStreamScroll();
  setupManualUrl();
  setupRRCalc();
  setupJournalForm();
  setupJournalPairSelect();
  setupAnalyzeButton();
  setupMsmAnalyseButton();
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


// ── Tab switching ─────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  const isLive      = tab === 'live';
  const isBacktest  = tab === 'backtest';
  const isStats     = tab === 'stats';
  const isStreamLog = tab === 'stream-log';
  const isCourse    = tab === 'course';
  const isLife      = tab === 'life';

  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.getElementById('grid-container')?.classList.toggle('hidden', !isLive);
  document.getElementById('backtest-panel')?.classList.toggle('hidden', !isBacktest);
  document.getElementById('stats-panel')?.classList.toggle('hidden', !isStats);
  document.getElementById('stream-log-panel')?.classList.toggle('hidden', !isStreamLog);
  document.getElementById('course-panel')?.classList.toggle('hidden', !isCourse);
  document.getElementById('life-panel')?.classList.toggle('hidden', !isLife);

  // Hide live-only toolbar buttons when not on live tab
  ['btn-sync', 'btn-refresh'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isLive ? '' : 'none';
  });

  if (isBacktest) { populateChannelSelect(); populatePairSelect(); }
  if (isStats     && typeof onStatsTabActivated     === 'function') onStatsTabActivated();
  if (isStreamLog && typeof onStreamLogTabActivated === 'function') onStreamLogTabActivated();
  if (isCourse    && typeof onCourseTabActivated    === 'function') onCourseTabActivated();
  if (isLife      && typeof onLifeTabActivated      === 'function') onLifeTabActivated();
}

// ── Source toggle (YouTube Channel / URL) ────────────────────────────────
function setupSourceToggle() {
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const src = btn.dataset.source;
      document.getElementById('source-channel').classList.toggle('hidden', src !== 'channel');
      document.getElementById('source-url').classList.toggle('hidden', src !== 'url');
    });
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
      await loadReviewedIds(btChannelId);
      await loadPastStreams(btChannelId, null);
    }
  });
}

// ── Manual URL Loader ─────────────────────────────────────────────────────
function setupManualUrl() {
  const input    = document.getElementById('manual-url-input');
  const btn      = document.getElementById('btn-manual-url-load');
  const status   = document.getElementById('manual-url-status');
  const progress = document.getElementById('manual-url-progress');

  function tryLoad() {
    const raw = input.value.trim();
    if (!raw) return;
    const videoId = extractVideoIdFromUrl(raw);
    if (!videoId) {
      status.textContent = 'Could not find a video ID in that URL.';
      status.style.display = '';
      progress.classList.add('hidden');
      return;
    }
    status.style.display = 'none';
    progress.classList.remove('hidden');
    input.value = '';
    setTimeout(() => progress.classList.add('hidden'), 1200);
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

    if (!data.cached) window.trackQuotaUnits?.(100);
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
    const thumbHtml = s.thumbnail
      ? `<img class="stream-card-thumb" src="${btEscAttr(s.thumbnail)}" alt="">`
      : `<div class="stream-card-thumb-placeholder">&#9654;</div>`;
    card.innerHTML = `
      <div class="stream-card-thumb-wrap">${thumbHtml}</div>
      <div class="stream-card-body">
        <div class="stream-card-title">${btEscHtml(s.title)}</div>
        <div class="stream-card-footer">
          <span class="stream-card-date">${date}</span>
          <button class="stream-card-tick" title="Mark as reviewed" type="button">✓</button>
        </div>
      </div>
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

function setupStreamScroll() {
  // Scroll buttons removed — streams now in vertical sidebar list
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
  btMarkers     = [];

  document.getElementById('backtest-player-title').textContent = title;
  const msmTitle = document.getElementById('msm-stream-title');
  if (msmTitle) msmTitle.textContent = title;
  document.getElementById('backtest-player-empty').classList.add('hidden');
  document.getElementById('backtest-player-frame').classList.remove('hidden');
  document.getElementById('journal-context').textContent = `Logging for: ${title}`;
  const analyzeBtn2 = document.getElementById('btn-analyze-stream');
  if (analyzeBtn2) analyzeBtn2.disabled = false;
  const msmBtn = document.getElementById('btn-msm-analyse');
  if (msmBtn) msmBtn.disabled = false;
  renderPlayerMeta(stream);
  resetAnalysisState(true);
  resetMsmPanel();

  if (btPlayer) {
    btPlayer.loadVideoById(videoId);
  } else {
    btPlayer = new YT.Player('backtest-player', {
      videoId,
      width:  '100%',
      height: '100%',
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
  btMarkers     = [];
  document.getElementById('backtest-player-title').textContent = 'No stream selected';
  const msmTitleR = document.getElementById('msm-stream-title');
  if (msmTitleR) msmTitleR.textContent = '—';
  document.getElementById('backtest-player-empty').classList.remove('hidden');
  document.getElementById('backtest-player-frame').classList.add('hidden');
  document.getElementById('player-meta').innerHTML = '';
  const analyzeBtn = document.getElementById('btn-analyze-stream');
  if (analyzeBtn) analyzeBtn.disabled = true;
  const msmBtnR = document.getElementById('btn-msm-analyse');
  if (msmBtnR) msmBtnR.disabled = true;
  resetAnalysisState(true);
  resetMsmPanel();
  if (btPlayer) {
    try { btPlayer.destroy(); } catch {}
    btPlayer = null;
  }
}

function setupAnalyzeButton() {
  const btn = document.getElementById('btn-analyze-stream');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!btStreamId || !btChannelId) {
      btShowToast('Select a stream first', 'error');
      return;
    }
    await analyzeStream(btStreamId, btChannelId);
  });
}

async function analyzeStream(videoId, channelId) {
  const btn = document.getElementById('btn-analyze-stream');
  const panel = document.getElementById('analysis-panel');
  const status = document.getElementById('analysis-status');

  btn.disabled = true;
  btn.textContent = 'Analyzing...';
  panel.classList.remove('hidden');
  status.textContent = 'Scanning transcript and extracting trade moments...';
  document.getElementById('analysis-markers').innerHTML = '';

  try {
    const res = await fetch(
      `/.netlify/functions/analyze-stream?videoId=${encodeURIComponent(videoId)}&channelId=${encodeURIComponent(channelId)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Whisper STT fallback — YouTube captions unavailable, queued for background processing
    if (data.pendingWhisper) {
      status.textContent = 'YouTube captions unavailable — queued for Whisper transcription. Check back in 5–10 minutes.';
      btShowToast('Whisper transcription queued — auto-analysis will complete shortly', 'info');
      return;
    }

    const markers = Array.isArray(data.markers) ? data.markers : [];
    btMarkers = markers;

    if (!markers.length) {
      status.textContent = 'Analysis completed, but no trade markers were found for this stream.';
      return;
    }

    const cacheNote = data.cached ? 'Cached analysis loaded.' : 'Analysis completed.';
    status.textContent = `${cacheNote} Click a marker to jump the player.`;
    renderAnalysisMarkers(markers);
    btShowToast(`Loaded ${markers.length} marker${markers.length === 1 ? '' : 's'}`, 'success');
  } catch (err) {
    status.textContent = `Analysis unavailable: ${err.message}`;
    btShowToast(`Analyze failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze';
  }
}

function resetAnalysisState(hidePanel = false) {
  const panel = document.getElementById('analysis-panel');
  const status = document.getElementById('analysis-status');
  if (!panel || !status) return;
  document.getElementById('analysis-markers').innerHTML = '';
  status.textContent = btStreamId
    ? 'Run analysis to extract entry, exit, and discussion moments.'
    : 'Select a stream to enable transcript analysis.';
  if (hidePanel) {
    panel.classList.add('hidden');
  } else {
    panel.classList.remove('hidden');
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

function renderAnalysisMarkers(markers) {
  const panel = document.getElementById('analysis-panel');
  const container = document.getElementById('analysis-markers');
  if (!panel || !container) return;
  panel.classList.remove('hidden');
  container.innerHTML = '';

  for (const marker of markers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `analysis-marker marker-${normalizeMarkerType(marker.type)}`;
    btn.innerHTML = `
      <span class="marker-time">${btEscHtml(fmtTime(Number(marker.ts) || 0))}</span>
      <span class="marker-label">${btEscHtml(marker.label || 'Marker')}</span>
    `;
    btn.addEventListener('click', () => seekToMarker(marker));
    container.appendChild(btn);
  }
}

function seekToMarker(marker) {
  const ts = Number(marker.ts);
  if (!Number.isFinite(ts) || ts < 0) return;

  try {
    btPlayer?.seekTo(ts, true);
    const tsInput = document.getElementById('trade-timestamp');
    if (tsInput) tsInput.value = String(Math.floor(ts));
  } catch {}
}

function normalizeMarkerType(type) {
  if (type === 'entry' || type === 'exit') return type;
  return 'discussion';
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
  ['trade-entry', 'trade-exit', 'trade-stop'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', calcRR);
  });
}

function calcRR() {
  const entry = parseFloat(document.getElementById('trade-entry').value);
  const exit  = parseFloat(document.getElementById('trade-exit').value);
  const stop  = parseFloat(document.getElementById('trade-stop').value);
  const rrEl  = document.getElementById('trade-rr');
  if (!isNaN(entry) && !isNaN(exit) && !isNaN(stop) && stop !== entry) {
    rrEl.value = Math.abs((exit - entry) / (entry - stop)).toFixed(2);
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
      pair:               document.getElementById('trade-pair').value.trim() || null,
      direction:          document.getElementById('trade-direction').value,
      result:             document.getElementById('trade-result').value,
      entry:              parseFloat(document.getElementById('trade-entry').value)      || null,
      exit:               parseFloat(document.getElementById('trade-exit').value)       || null,
      stop:               parseFloat(document.getElementById('trade-stop').value)       || null,
      rr:                 parseFloat(document.getElementById('trade-rr').value)         || null,
      notes:              document.getElementById('trade-notes').value.trim(),
      videoTimestamp,
      session:            document.getElementById('trade-session').value             || null,
      timeframe:          document.getElementById('trade-timeframe').value           || null,
      htfPoi:             document.getElementById('trade-htf-poi').value             || null,
      entryModel:         document.getElementById('trade-entry-model').value         || null,
      pullbackDepth:      document.getElementById('trade-pullback-depth').value      || null,
      confirmationCandle: document.getElementById('trade-confirmation-candle').value || null,
      candleQuality:      document.getElementById('trade-candle-quality').value      || null,
      chochConfirmed:     document.getElementById('trade-choch').checked,
      liquiditySwept:     document.getElementById('trade-liq-swept').checked,
      rrPlanned:          parseFloat(document.getElementById('trade-rr-planned').value) || null,
      riskPercent:        parseFloat(document.getElementById('trade-risk').value)        || null,
      rating:             parseInt(document.getElementById('trade-rating').value)        || null,
      followedRules:      document.getElementById('trade-followed-rules').checked,
      tradingviewUrl:     document.getElementById('trade-tv-url').value.trim()       || null,
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
    const sessionLabel   = e.session   ? e.session.charAt(0).toUpperCase() + e.session.slice(1) : null;
    const ratingStars    = e.rating    ? '&#9733;'.repeat(e.rating) + '&#9734;'.repeat(5 - e.rating) : null;
    const isTVSnapshot   = e.tradingviewUrl && /tradingview\.com\/x\/[a-zA-Z0-9]+/.test(e.tradingviewUrl);
    const tvLink         = e.tradingviewUrl
      ? (isTVSnapshot
          ? `<a class="je-tv-thumb" href="${btEscHtml(e.tradingviewUrl)}" target="_blank" rel="noopener"><img src="${btEscHtml(e.tradingviewUrl)}" alt="Chart" loading="lazy"></a>`
          : `<a class="je-tv-link" href="${btEscHtml(e.tradingviewUrl)}" target="_blank" rel="noopener">View Chart &#8599;</a>`)
      : '';

    const msmTags = [
      e.session        ? `<span class="je-tag je-session">${btEscHtml(sessionLabel)}</span>` : '',
      e.timeframe      ? `<span class="je-tag">${btEscHtml(e.timeframe)}</span>` : '',
      e.htfPoi         ? `<span class="je-tag">${btEscHtml(e.htfPoi)}</span>` : '',
      e.entryModel     ? `<span class="je-tag">${btEscHtml(e.entryModel)}</span>` : '',
      e.candleQuality  ? `<span class="je-tag je-quality-${e.candleQuality}">${btEscHtml(e.candleQuality)}</span>` : '',
      e.chochConfirmed ? `<span class="je-tag je-check">CHOCH &#10003;</span>` : '',
      e.liquiditySwept ? `<span class="je-tag je-check">Liq &#10003;</span>` : '',
      e.followedRules  ? `<span class="je-tag je-check">Rules &#10003;</span>` : '',
    ].filter(Boolean).join('');

    el.innerHTML = `
      <div class="je-header">
        ${e.pair ? `<span class="je-pair">${btEscHtml(e.pair)}</span>` : ''}
        <span class="je-direction ${e.direction}">${e.direction.toUpperCase()}</span>
        <span class="je-result ${e.result}">${e.result.toUpperCase()}</span>
        ${e.rr       ? `<span class="je-rr">${e.rr}R</span>` : ''}
        ${e.rrPlanned ? `<span class="je-rr-planned" title="Planned RR">${e.rrPlanned}R plan</span>` : ''}
        ${ratingStars ? `<span class="je-rating" title="Rating">${ratingStars}</span>` : ''}
        ${ts         ? `<span class="je-ts">${btEscHtml(ts)}</span>` : ''}
        <button class="je-delete" title="Delete">&times;</button>
      </div>
      ${msmTags ? `<div class="je-msm-tags">${msmTags}</div>` : ''}
      ${e.notes ? `<div class="je-notes">${btEscHtml(e.notes)}</div>` : ''}
      ${tvLink}
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

  if (!dropArea) return;

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

// ── MSM Strategy Analysis ─────────────────────────────────────────────────

function setupMsmAnalyseButton() {
  const btn       = document.getElementById('btn-msm-analyse');
  const reanalyse = document.getElementById('btn-msm-reanalyse');
  const pasteBtn  = document.getElementById('btn-msm-analyse-pasted');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!btStreamId) { btShowToast('Select a stream first', 'error'); return; }
    runMsmAnalysis(btStreamId, false, null);
  });

  if (reanalyse) {
    reanalyse.addEventListener('click', () => {
      if (!btStreamId) return;
      runMsmAnalysis(btStreamId, false, null, true);
    });
  }

  if (pasteBtn) {
    pasteBtn.addEventListener('click', () => {
      const text = document.getElementById('msm-paste-input')?.value?.trim();
      if (!text) { btShowToast('Paste some text first', 'error'); return; }
      runMsmAnalysis(btStreamId, false, text);
    });
  }
}

async function runMsmAnalysis(videoId, _unused = false, pastedText = null, force = false) {
  const panel     = document.getElementById('msm-panel');
  const status    = document.getElementById('msm-status');
  const content   = document.getElementById('msm-content');
  const pasteZone = document.getElementById('msm-paste-zone');
  const btn       = document.getElementById('btn-msm-analyse');
  const pasteBtn  = document.getElementById('btn-msm-analyse-pasted');
  const reanalyse = document.getElementById('btn-msm-reanalyse');

  panel.classList.remove('hidden');
  content.classList.add('hidden');
  pasteZone.classList.add('hidden');
  reanalyse.classList.add('hidden');
  status.textContent = pastedText
    ? 'Running MSM analysis on pasted text…'
    : 'Fetching transcript and running MSM analysis…';
  btn.disabled = true;
  btn.textContent = 'Analysing…';
  if (pasteBtn) pasteBtn.disabled = true;

  try {
    const res = await fetch('/.netlify/functions/msm-analyse', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ videoId, pastedText: pastedText || undefined, force }),
    });

    const data = await res.json().catch(() => ({}));

    // No captions — show paste zone
    if (res.status === 404 && data.error === 'noCaption') {
      status.textContent = 'YouTube captions unavailable. Paste your stream notes below to analyse.';
      pasteZone.classList.remove('hidden');
      return;
    }

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const cacheNote = data.cached ? 'Cached · ' : '';
    const tradeCount = data.trades?.length || 0;
    status.textContent = `${cacheNote}${tradeCount} trade${tradeCount === 1 ? '' : 's'} identified`;

    renderMsmAnalysis(data);
    reanalyse.classList.remove('hidden');
    content.classList.remove('hidden');
    btShowToast('MSM analysis loaded', 'success');

  } catch (err) {
    status.textContent = `Analysis failed: ${err.message}`;
    btShowToast(`MSM analyse failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'MSM Analyse';
    if (pasteBtn) pasteBtn.disabled = false;
  }
}

function resetMsmPanel() {
  const panel     = document.getElementById('msm-panel');
  const content   = document.getElementById('msm-content');
  const pasteZone = document.getElementById('msm-paste-zone');
  const status    = document.getElementById('msm-status');
  const reanalyse = document.getElementById('btn-msm-reanalyse');
  if (!panel) return;
  panel.classList.add('hidden');
  content?.classList.add('hidden');
  pasteZone?.classList.add('hidden');
  reanalyse?.classList.add('hidden');
  if (status) status.textContent = '';
}

function renderMsmAnalysis(data) {
  // Market context
  document.getElementById('msm-market-context-text').textContent = data.marketContext || '';

  // Conformity badge
  const badge = document.getElementById('msm-conformity-badge');
  badge.textContent = (data.msmConformity || 'medium').toUpperCase();
  badge.className = `msm-conformity-badge msm-conformity--${data.msmConformity || 'medium'}`;

  // Trades
  const tradesEl = document.getElementById('msm-trades');
  tradesEl.innerHTML = '';
  const trades = Array.isArray(data.trades) ? data.trades : [];

  trades.forEach((trade, idx) => {
    const card = document.createElement('div');
    card.className = `msm-trade-card msm-trade--${trade.result || 'be'}`;

    const checklist = trade.msmChecklist || {};
    const checkKeys = [
      ['marketStructure',    'Market Structure'],
      ['htfPoi',             'HTF POI'],
      ['choch',              'CHOCH'],
      ['pullback',           'Pullback'],
      ['slowPullback',       'Slow Pullback'],
      ['confirmationCandle', 'Confirmation Candle'],
      ['slPlacement',        'SL Placement'],
      ['liquidityTarget',    'Liquidity Target'],
    ];
    const checkHtml = checkKeys.map(([k, label]) =>
      `<span class="msm-check ${checklist[k] ? 'msm-check--yes' : 'msm-check--no'}" title="${label}">
        ${checklist[k] ? '&#10003;' : '&#10007;'} ${btEscHtml(label)}
      </span>`
    ).join('');

    const insights = Array.isArray(trade.executionInsights) ? trade.executionInsights : [];
    const insightsHtml = insights.length
      ? `<ul class="msm-insights-list">${insights.map(i => `<li>${btEscHtml(i)}</li>`).join('')}</ul>`
      : '';

    const dirIcon  = trade.direction === 'long' ? '&#9650;' : '&#9660;';
    const dirClass = trade.direction === 'long' ? 'msm-dir--long' : 'msm-dir--short';
    const resultLabels = { win: 'WIN', loss: 'LOSS', be: 'BE' };

    card.innerHTML = `
      <div class="msm-trade-header">
        <div class="msm-trade-title">
          <span class="msm-trade-pair">${btEscHtml(trade.pair || 'Unknown')}</span>
          <span class="msm-trade-dir ${dirClass}">${dirIcon} ${(trade.direction || '').toUpperCase()}</span>
          ${trade.session ? `<span class="msm-trade-meta">${btEscHtml(trade.session.toUpperCase())}</span>` : ''}
          ${trade.timeframe ? `<span class="msm-trade-meta">${btEscHtml(trade.timeframe)}</span>` : ''}
        </div>
        <div class="msm-trade-right">
          <span class="msm-result-badge msm-result--${trade.result}">${resultLabels[trade.result] || 'BE'}</span>
          ${trade.partialTp ? '<span class="msm-partial-badge">Partial TP</span>' : ''}
          <button class="ghost-btn msm-autofill-btn" type="button" data-trade-idx="${idx}">Auto-fill Journal</button>
        </div>
      </div>

      <p class="msm-trade-summary">${btEscHtml(trade.summary)}</p>

      <div class="msm-checklist-row">${checkHtml}</div>

      <div class="msm-details-grid">
        ${msmDetailRow('HTF Bias',       trade.htfBias)}
        ${msmDetailRow('HTF POI',        trade.htfPoi)}
        ${msmDetailRow('CHOCH',          trade.choch)}
        ${msmDetailRow('Pullback',       trade.pullbackType + (trade.pullbackZone ? ` → ${trade.pullbackZone}` : ''))}
        ${msmDetailRow('Confirmation',   trade.confirmationCandle)}
        ${msmDetailRow('Entry Logic',    trade.entryReasoning)}
        ${msmDetailRow('SL',             trade.slPlacement)}
        ${msmDetailRow('TP Targets',     trade.tpTargets)}
        ${msmDetailRow('Drawdown',       trade.drawdown)}
        ${msmDetailRow('During Drawdown',trade.drawdownResponse)}
      </div>

      ${trade.psychologyNotes ? `<div class="msm-psychology"><span class="msm-psych-icon">&#129504;</span> ${btEscHtml(trade.psychologyNotes)}</div>` : ''}
      ${insightsHtml ? `<div class="msm-section-label" style="margin-top:12px">Execution Insights</div>${insightsHtml}` : ''}
    `;

    // Wire auto-fill button
    card.querySelector('.msm-autofill-btn').addEventListener('click', () => msmAutoFill(trade));

    tradesEl.appendChild(card);
  });

  if (trades.length === 0) {
    tradesEl.innerHTML = '<p class="panel-status">No trades were identified in this stream.</p>';
  }

  // Lessons
  const lessons = Array.isArray(data.topLessons) ? data.topLessons : [];
  const lessonsList = document.getElementById('msm-lessons-list');
  lessonsList.innerHTML = lessons.map(l => `<li>${btEscHtml(l)}</li>`).join('');
}

function msmDetailRow(label, value) {
  if (!value) return '';
  return `<div class="msm-detail-row">
    <span class="msm-detail-label">${btEscHtml(label)}</span>
    <span class="msm-detail-value">${btEscHtml(value)}</span>
  </div>`;
}

function msmAutoFill(trade) {
  if (!trade) return;

  const existingPairs = [
    ...(typeof DEFAULT_PAIRS !== 'undefined' ? DEFAULT_PAIRS : []),
    ...(typeof customPairs   !== 'undefined' ? customPairs   : []),
  ];

  // Pair
  if (trade.pair) {
    const sel   = document.getElementById('trade-pair');
    const match = existingPairs.find(p => p.value.toUpperCase() === trade.pair.toUpperCase());
    if (match) {
      sel.value = match.value;
    } else {
      document.getElementById('trade-pair-label-in').value = trade.pair;
      document.getElementById('trade-pair-value-in').value = trade.pair.toUpperCase();
      document.getElementById('trade-pair-add-row').classList.remove('hidden');
    }
  }

  if (trade.direction) {
    const dirSel = document.getElementById('trade-direction');
    if (dirSel) dirSel.value = trade.direction;
  }

  if (trade.result) {
    const resSel = document.getElementById('trade-result');
    if (resSel) resSel.value = trade.result;
  }

  if (trade.session) {
    const sessSel = document.getElementById('trade-session');
    if (sessSel) sessSel.value = trade.session;
  }

  if (trade.timeframe) {
    const tfSel = document.getElementById('trade-timeframe');
    if (tfSel) tfSel.value = trade.timeframe;
  }

  // MSM fields
  if (trade.htfPoi) {
    const htfEl = document.getElementById('trade-htf-poi');
    if (htfEl) htfEl.value = trade.htfPoi;
  }

  if (trade.choch) {
    const chochEl = document.getElementById('trade-choch');
    if (chochEl) chochEl.value = trade.choch;
  }

  if (trade.pullbackType || trade.pullbackZone) {
    const pbEl = document.getElementById('trade-pullback-depth');
    if (pbEl && !pbEl.value) pbEl.value = trade.pullbackZone || trade.pullbackType;
  }

  if (trade.confirmationCandle) {
    const ccEl = document.getElementById('trade-confirmation-candle');
    if (ccEl) ccEl.value = trade.confirmationCandle;
  }

  // Build notes from summary + psychology
  const notesEl = document.getElementById('trade-notes');
  if (notesEl && !notesEl.value) {
    const parts = [];
    if (trade.summary)         parts.push(trade.summary);
    if (trade.psychologyNotes) parts.push(`Psychology: ${trade.psychologyNotes}`);
    if (trade.drawdown)        parts.push(`Drawdown: ${trade.drawdown}`);
    notesEl.value = parts.join('\n\n');
  }

  // Scroll to form
  document.querySelector('.backtest-journal')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  btShowToast('Journal form filled from MSM analysis', 'success');
}

// Use the toast from app.js if available, otherwise log
function btShowToast(msg, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(msg, type);
  } else {
    console.log(`[${type}] ${msg}`);
  }
}