'use strict';


// ── Constants ─────────────────────────────────────────────────────────────
const LS_CHANNELS = 'tradingDashboard_channels';
// LS_GRID_COLS removed — layout is now automatic
const LS_ACTIVE_AUDIO = 'tradingDashboard_activeAudio';
const LS_API_KEY = 'tradingDashboard_apiKey';
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Default currency pair list (global, shared across all channels)
const DEFAULT_PAIRS = [
  { label: 'XAU/USD (Gold)',    value: 'XAUUSD' },
  { label: 'EUR/USD',           value: 'EURUSD' },
  { label: 'GBP/USD',           value: 'GBPUSD' },
  { label: 'USD/JPY',           value: 'USDJPY' },
  { label: 'GBP/JPY',           value: 'GBPJPY' },
  { label: 'NAS100',            value: 'NAS100' },
  { label: 'US30 (Dow)',        value: 'US30' },
  { label: 'BTC/USD (Bitcoin)', value: 'BTCUSD' },
  { label: 'ETH/USD',           value: 'ETHUSD' },
  { label: 'USD/CAD',           value: 'USDCAD' },
];

// ── State ─────────────────────────────────────────────────────────────────
let channels = [];          // { channelId, name, handle, videoId, isLive, viewers, pair }
let customPairs = [];       // global user-defined pairs { label, value }
let playerMap = new Map();  // channelId → YT.Player instance
let activeAudioChannel = null; // channelId with audio on; null = all muted
let gridCols = 1;  // computed automatically from live count
let gridRows = 1;
let localYoutubeProxyAvailable = false;

const LIVE_EDGE_THRESHOLD_S = 120; // auto-seek only if >2min behind live edge (normal HLS buffer is 15-30s)
let apiKey = '';
let isRefreshing = false;

// ── Entry point ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupTabs();    // synchronous — must run before any awaits so tabs work immediately
  setupToolbar();
  setupModal();
  await loadState();
  await loadCustomPairs();
  await detectLocalYoutubeProxy();
  requestNotificationPermission();
  injectYouTubeAPI();
}


// ── State Persistence ─────────────────────────────────────────────────────
async function loadState() {
  // API key and active audio stay in localStorage (per-browser is fine)
  apiKey = localStorage.getItem(LS_API_KEY) || window.TRADING_CONFIG?.API_KEY || '';
  activeAudioChannel = localStorage.getItem(LS_ACTIVE_AUDIO) || null;

  // Channels: try remote store first when deployed
  if (!isLocalHost) {
    try {
      const res = await fetch('/.netlify/functions/channels');
      if (res.ok) {
        const remote = await res.json();
        if (Array.isArray(remote) && remote.length > 0) {
          // Remote has data — use it as source of truth
          channels = normaliseLoadedChannels(remote);
          localStorage.setItem(LS_CHANNELS, JSON.stringify(channels));
          return;
        }
        // Remote is empty — migrate from localStorage if anything is there
        let local = [];
        try { local = JSON.parse(localStorage.getItem(LS_CHANNELS) || '[]'); } catch {}
        if (local.length > 0) {
          channels = normaliseLoadedChannels(local);
          saveChannels(); // uploads to remote
          return;
        }
      }
    } catch (err) {
      console.warn('[loadState] remote fetch failed, using localStorage:', err.message);
    }
  }

  // Localhost or remote unavailable — fall back to localStorage + config defaults
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(LS_CHANNELS) || '[]');
  } catch { saved = []; }

  const defaults = window.TRADING_CONFIG?.DEFAULT_CHANNELS || [];
  const seenIds = new Set(saved.map(c => c.channelId).filter(Boolean));
  const seenHandles = new Set(saved.map(c => c.handle).filter(Boolean));
  for (const def of defaults) {
    const alreadyPresent = (def.channelId && seenIds.has(def.channelId))
                        || (def.handle && seenHandles.has(def.handle));
    if (!alreadyPresent) {
      saved.push({ ...def, videoId: null, isLive: false, viewers: 0 });
    }
  }
  channels = normaliseLoadedChannels(saved);
  saveChannels();
}

function normaliseLoadedChannels(list) {
  return (Array.isArray(list) ? list : []).map(ch => ({
    ...ch,
    // Live status is volatile runtime state. Never trust persisted values on boot.
    videoId: null,
    isLive: false,
    viewers: 0,
    paused: false,
  }));
}

function saveChannels() {
  localStorage.setItem(LS_CHANNELS, JSON.stringify(channels));
  // Persist to remote on deployed site (fire-and-forget)
  if (!isLocalHost) {
    fetch('/.netlify/functions/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(channels),
    }).catch(err => console.warn('[saveChannels] remote save failed:', err.message));
  }
}


function saveActiveAudio() {
  if (activeAudioChannel) {
    localStorage.setItem(LS_ACTIVE_AUDIO, activeAudioChannel);
  } else {
    localStorage.removeItem(LS_ACTIVE_AUDIO);
  }
}

function saveApiKey(key) {
  apiKey = key.trim();
  localStorage.setItem(LS_API_KEY, apiKey);
}

// ── Custom Pairs Persistence ──────────────────────────────────────────────
async function loadCustomPairs() {
  if (!isLocalHost) {
    try {
      const res = await fetch('/.netlify/functions/custom-pairs');
      if (res.ok) {
        const remote = await res.json();
        if (Array.isArray(remote)) { customPairs = remote; return; }
      }
    } catch (err) {
      console.warn('[loadCustomPairs] remote fetch failed:', err.message);
    }
  }
  try {
    customPairs = JSON.parse(localStorage.getItem('tradingDashboard_customPairs') || '[]');
  } catch { customPairs = []; }
}

function saveCustomPairs() {
  localStorage.setItem('tradingDashboard_customPairs', JSON.stringify(customPairs));
  if (!isLocalHost) {
    // Remote is updated per-operation (POST/DELETE) — no bulk save needed here
  }
}

// ── Pair Helpers ──────────────────────────────────────────────────────────
function setPairForChannel(channelId, pairValue) {
  const ch = channels.find(c => c.channelId === channelId);
  if (!ch) return;
  ch.pair = pairValue || null;
  saveChannels();
}

async function addCustomPair(label, value) {
  if (customPairs.some(p => p.value === value)) return; // already exists
  const pair = { label: label.slice(0, 40), value: value.slice(0, 20) };
  customPairs.push(pair);
  saveCustomPairs();
  if (!isLocalHost) {
    try {
      await fetch('/.netlify/functions/custom-pairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pair),
      });
    } catch (err) {
      console.warn('[addCustomPair] remote save failed:', err.message);
    }
  }
}

// ── Browser Notifications ─────────────────────────────────────────────────
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    // Delay so the page feels loaded before asking
    setTimeout(() => Notification.requestPermission(), 3000);
  }
}

function notifyChannelLive(ch) {
  const title = `${ch.name || ch.handle || 'Channel'} is LIVE`;
  const body  = ch.streamTitle || 'Live stream started';
  // Browser push notification (only when tab is open)
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/favicon.ico' }); } catch {}
  }
  // On-screen toast regardless of permission
  showToast(`🔴 ${title}`, 'success');
}

// ── YouTube IFrame API ────────────────────────────────────────────────────
function injectYouTubeAPI() {
  if (window.YT && window.YT.Player) {
    initDashboard();
    return;
  }
  window.onYouTubeIframeAPIReady = initDashboard;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

async function detectLocalYoutubeProxy() {
  if (!isLocalHost) {
    localYoutubeProxyAvailable = true;
    return;
  }

  try {
    const res = await fetch('/.netlify/functions/youtube');
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    localYoutubeProxyAvailable = !!data?.keyPresent;
  } catch {
    localYoutubeProxyAvailable = false;
  }
}

// Returns true if API calls will work — either a local key is set,
// or we're on a deployed host where the serverless proxy provides the key.
function hasApiAccess() {
  if (!isLocalHost) return true; // Netlify function handles the key server-side
  if (localYoutubeProxyAvailable) return true; // netlify dev + .env
  return !!(apiKey && apiKey !== 'YOUR_GOOGLE_API_KEY_HERE' && apiKey !== '');
}

async function initDashboard() {
  updateLiveCount();
  if (!hasApiAccess()) {
    showEmptyState('Set your API key to get started', '🔑');
    openModal();
    showToast('Please set your YouTube API key first', 'info');
    return;
  }
  if (channels.length === 0) {
    showEmptyState('Add channels to start monitoring', '📺');
    openModal();
    return;
  }
  showSkeletons();
  await refreshAllChannels();
  buildGrid();
}

// ── API Calls ─────────────────────────────────────────────────────────────
async function apiFetch(endpoint, params) {
  let url;

  if (isLocalHost && !localYoutubeProxyAvailable && apiKey && apiKey !== 'YOUR_GOOGLE_API_KEY_HERE') {
    // Local dev: call YouTube API directly with the stored key
    url = new URL(`${YT_API_BASE}/${endpoint}`);
    params.key = apiKey;
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  } else {
    // Deployed: route through serverless proxy — key stays server-side
    url = new URL('/.netlify/functions/youtube', window.location.origin);
    url.searchParams.set('endpoint', endpoint);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json();
}

// Resolve @handle or channel URL → channelId (1 quota unit, cached)
async function resolveHandle(handle) {
  const cleanHandle = handle.replace(/^@/, '');
  const data = await apiFetch('channels', { part: 'id', forHandle: cleanHandle });
  return data?.items?.[0]?.id || null;
}

// Resolve a video ID → { channelId, channelTitle } (1 quota unit)
async function resolveVideoId(videoId) {
  const data = await apiFetch('videos', {
    part: 'snippet',
    id: videoId,
  });
  const item = data?.items?.[0];
  if (!item) return null;
  return {
    channelId: item.snippet.channelId,
    name: item.snippet.channelTitle,
    videoId,
    isLive: item.snippet.liveBroadcastContent === 'live',
  };
}

// Get current live video ID for a channel (100 quota units)
async function fetchLiveVideoId(channelId) {
  const data = await apiFetch('search', {
    part: 'id',
    channelId,
    eventType: 'live',
    type: 'video',
    maxResults: 1,
  });
  return data?.items?.[0]?.id?.videoId || null;
}

// Batch-confirm live status of known video IDs (1 quota unit for all)
async function batchCheckLiveStatus(videoIds) {
  if (!videoIds.length) return new Map();
  const data = await apiFetch('videos', {
    part: 'snippet,liveStreamingDetails',
    id: videoIds.join(','),
  });
  const result = new Map();
  for (const item of data?.items || []) {
    result.set(item.id, {
      isLive: item.snippet?.liveBroadcastContent === 'live',
      viewers: parseInt(item.liveStreamingDetails?.concurrentViewers || '0', 10),
      title: item.snippet?.title || '',
    });
  }
  return result;
}

// Run search.list only for offline channels; batch-check known live ones cheaply.
// search costs 100 units/channel — skip it for channels already tracked as live.
async function refreshAllChannels() {
  if (!channels.length) return;
  isRefreshing = true;
  document.getElementById('btn-refresh')?.classList.add('spinning');

  // Batch-confirm channels we already know are live (1 unit total)
  const liveChannels = channels.filter(c => c.videoId);
  if (liveChannels.length) {
    try {
      const statusMap = await batchCheckLiveStatus(liveChannels.map(c => c.videoId));
      for (const ch of liveChannels) {
        const s = statusMap.get(ch.videoId);
        if (!s || !s.isLive) {
          ch.isLive = false;
          ch.videoId = null;
          ch.viewers = 0;
        } else {
          ch.viewers = s.viewers;
        }
      }
    } catch (err) {
      console.warn('[batchCheck]', err.message);
    }
  }

  // Search only offline channels for new streams (100 units each)
  const offlineChannels = channels.filter(c => !c.videoId && !c.manualVideoId);
  for (const ch of offlineChannels) {
    try {
      const videoId = await fetchLiveVideoId(ch.channelId);
      ch.videoId = videoId;
      ch.isLive = !!videoId;
      if (!videoId) ch.viewers = 0;
      if (ch.isLive) notifyChannelLive(ch);
    } catch (err) {
      console.warn(`[refresh] ${ch.name}: ${err.message}`);
    }
  }

  saveChannels();
  isRefreshing = false;
  document.getElementById('btn-refresh')?.classList.remove('spinning');
  updateLiveCount();
}

// Fast poll — only checks known videoIds (cheap)
async function checkLiveStatus() {
  const liveChannels = channels.filter(c => c.videoId);
  if (!liveChannels.length) return;

  try {
    const statusMap = await batchCheckLiveStatus(liveChannels.map(c => c.videoId));
    let changed = false;
    for (const ch of liveChannels) {
      const s = statusMap.get(ch.videoId);
      if (!s || !s.isLive) {
        // Stream ended
        ch.isLive = false;
        ch.videoId = null;
        ch.viewers = 0;
        changed = true;
      } else {
        ch.viewers = s.viewers;
        updateViewerCount(ch.channelId, s.viewers);
      }
    }
    if (changed) {
      saveChannels();
      buildGrid();
    }
    updateLiveCount();
  } catch (err) {
    console.warn('[checkLiveStatus]', err.message);
  }
}

// ── Grid Management ───────────────────────────────────────────────────────
function buildGrid() {
  destroyAllPlayers();

  const container = document.getElementById('grid-container');
  container.innerHTML = '';

  const liveChannels = channels.filter(c => c.isLive && c.videoId);
  const activeLive = liveChannels.filter(c => !c.paused);
  const pausedLive = liveChannels.filter(c => c.paused);

  if (channels.length === 0) {
    showEmptyState('Add channels to start monitoring', '📺');
    return;
  }
  if (liveChannels.length === 0) {
    showEmptyState('No channels are live right now', '📡');
    return;
  }

  // Auto-compute grid dimensions from total visible cells (active + paused)
  const count = liveChannels.length;
  gridCols = autoGridCols(count);
  gridRows = Math.max(1, Math.ceil(count / gridCols));
  applyGridVars();

  // Active streams — create player
  for (const ch of activeLive) {
    const cell = createStreamCell(ch);
    container.appendChild(cell);
    createPlayer(cell, ch);
  }

  // Paused streams — show placeholder cell, no player
  for (const ch of pausedLive) {
    container.appendChild(createPausedCell(ch));
  }

  updateLiveCount();
}

function createStreamCell(ch) {
  const cell = document.createElement('div');
  cell.className = 'stream-cell';
  cell.dataset.channelId = ch.channelId;

  const accent = document.createElement('div');
  accent.className = 'cell-accent';

  const overlay = document.createElement('div');
  overlay.className = 'stream-overlay';

  const header = document.createElement('div');
  header.className = 'stream-header';
  header.innerHTML = `
    <span class="stream-label">${escHtml(ch.name || ch.handle || ch.channelId)}</span>
    <span class="live-badge">LIVE</span>
    <span class="viewer-count">${formatViewers(ch.viewers)}</span>
  `;

  const footer = document.createElement('div');
  footer.className = 'stream-footer';

  // Volume button — solo audio (only this stream plays loud)
  const isActive = activeAudioChannel === ch.channelId;
  const volBtn = document.createElement('button');
  volBtn.className = `btn-volume${isActive ? ' active-audio' : ''}`;
  volBtn.title = isActive ? 'Mute this stream' : 'Play this stream loud (mutes others)';
  volBtn.innerHTML = isActive ? '🔊' : '🔇';
  volBtn.addEventListener('click', () => selectAudio(ch.channelId));

  // Pause button — pauses stream, keeps channel saved
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'btn-pause';
  pauseBtn.title = 'Pause stream';
  pauseBtn.innerHTML = '⏸';
  pauseBtn.addEventListener('click', () => pauseStream(ch.channelId));

  footer.appendChild(volBtn);
  footer.appendChild(pauseBtn);
  overlay.appendChild(header);
  overlay.appendChild(footer);
  cell.appendChild(accent);
  cell.appendChild(overlay);

  return cell;
}

function createPausedCell(ch) {
  const cell = document.createElement('div');
  cell.className = 'stream-cell paused-cell';
  cell.dataset.channelId = ch.channelId;
  cell.innerHTML = `
    <div class="paused-overlay">
      <div class="paused-icon">⏸</div>
      <div class="paused-label">${escHtml(ch.name || ch.handle || ch.channelId)}</div>
      <button class="btn-resume">▶ Resume</button>
    </div>
  `;
  cell.querySelector('.btn-resume').addEventListener('click', () => resumeStream(ch.channelId));
  return cell;
}

function createPlayer(cellEl, ch) {
  const playerDiv = document.createElement('div');
  cellEl.insertBefore(playerDiv, cellEl.firstChild);

  const shouldHaveAudio = activeAudioChannel === ch.channelId;

  const player = new YT.Player(playerDiv, {
    videoId: ch.videoId,
    playerVars: {
      autoplay: 1,
      mute: 1,       // always start muted (required for autoplay)
      controls: 1,
      rel: 0,
      modestbranding: 1,
      enablejsapi: 1,
    },
    events: {
      onReady: (event) => {
        event.target.mute();
        event.target.playVideo();
        // Restore audio for the selected stream
        if (shouldHaveAudio) {
          setTimeout(() => {
            try { event.target.unMute(); } catch {}
          }, 1500);
        }
      },
      onAutoplayBlocked: () => {
        showToast(`${ch.name}: click to play`, 'info');
      },
      onError: (event) => {
        console.warn(`[player error] ${ch.name}: code ${event.data}`);
      },
    },
  });

  playerMap.set(ch.channelId, player);
}

function destroyAllPlayers() {
  for (const [, player] of playerMap) {
    try { player.destroy(); } catch {}
  }
  playerMap.clear();
}

// Auto-calculate columns based on number of live streams
function autoGridCols(count) {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  return 4;
}

function applyGridVars() {
  const root = document.documentElement;
  root.style.setProperty('--grid-cols', gridCols);
  root.style.setProperty('--grid-rows', gridRows);
}

function showSkeletons() {
  const container = document.getElementById('grid-container');
  container.innerHTML = '';
  const count = Math.max(1, channels.length);
  gridCols = autoGridCols(count);
  gridRows = Math.max(1, Math.ceil(count / gridCols));
  for (let i = 0; i < count; i++) {
    const cell = document.createElement('div');
    cell.className = 'stream-cell skeleton';
    cell.innerHTML = '<div class="skeleton-pulse"></div>';
    container.appendChild(cell);
  }
  applyGridVars();
}

function showEmptyState(message, icon = '📺') {
  const container = document.getElementById('grid-container');
  container.innerHTML = `
    <div id="empty-state">
      <div class="big-icon">${icon}</div>
      <h2>${escHtml(message)}</h2>
      <p>Open ⚙ to manage channels</p>
    </div>
  `;
}


// ── Player Controls ───────────────────────────────────────────────────────

// Solo audio: unmute selected stream, mute all others.
// Clicking the already-active stream mutes everything.
function selectAudio(channelId) {
  const isAlreadyActive = activeAudioChannel === channelId;
  activeAudioChannel = isAlreadyActive ? null : channelId;
  saveActiveAudio();

  // Apply mute/unmute to all players
  for (const [id, player] of playerMap) {
    try {
      if (id === activeAudioChannel) {
        player.unMute();
      } else {
        player.mute();
      }
    } catch {}
  }

  // Update all volume buttons
  document.querySelectorAll('.stream-cell').forEach(cell => {
    const id = cell.dataset.channelId;
    const btn = cell.querySelector('.btn-volume');
    if (!btn) return;
    const isActive = id === activeAudioChannel;
    btn.className = `btn-volume${isActive ? ' active-audio' : ''}`;
    btn.title = isActive ? 'Mute this stream' : 'Play this stream loud (mutes others)';
    btn.innerHTML = isActive ? '🔊' : '🔇';
  });
}

function pauseStream(channelId) {
  const ch = channels.find(c => c.channelId === channelId);
  if (!ch) return;
  ch.paused = true;
  saveChannels();

  // If this was the audio stream, clear it
  if (activeAudioChannel === channelId) {
    activeAudioChannel = null;
    saveActiveAudio();
  }

  // Destroy this player and replace its cell with a paused cell
  const player = playerMap.get(channelId);
  try { player?.destroy(); } catch {}
  playerMap.delete(channelId);

  const oldCell = document.querySelector(`.stream-cell[data-channel-id="${channelId}"]`);
  if (oldCell) {
    const pausedCell = createPausedCell(ch);
    oldCell.replaceWith(pausedCell);
  }
}

function resumeStream(channelId) {
  const ch = channels.find(c => c.channelId === channelId);
  if (!ch) return;
  ch.paused = false;
  saveChannels();

  // Replace paused cell with a live cell + player
  const oldCell = document.querySelector(`.stream-cell[data-channel-id="${channelId}"]`);
  if (oldCell) {
    const liveCell = createStreamCell(ch);
    oldCell.replaceWith(liveCell);
    createPlayer(liveCell, ch);
  }
}

function syncAllStreams() {
  if (playerMap.size === 0) { showToast('No live streams to sync', 'info'); return; }
  let count = 0;
  for (const [, player] of playerMap) {
    try {
      // Seeking to getDuration() jumps to the live edge
      player.seekTo(player.getDuration(), true);
      count++;
    } catch {}
  }
  if (count > 0) {
    const btn = document.getElementById('btn-sync');
    btn.classList.add('syncing');
    setTimeout(() => btn.classList.remove('syncing'), 1000);
    showToast(`Synced ${count} stream${count > 1 ? 's' : ''} to live`, 'success');
  }
}

function updateViewerCount(channelId, viewers) {
  const cell = document.querySelector(`.stream-cell[data-channel-id="${channelId}"]`);
  const vc = cell?.querySelector('.viewer-count');
  if (vc) vc.textContent = formatViewers(viewers);
}

// ── Channel Management ────────────────────────────────────────────────────

// Extract an 11-char video ID from any YouTube URL format
function extractYouTubeVideoId(input) {
  const patterns = [
    /[?&]v=([\w-]{11})/,           // watch?v=ID  or  watch?foo=bar&v=ID
    /youtu\.be\/([\w-]{11})/,       // youtu.be/ID
    /youtube\.com\/live\/([\w-]{11})/,    // youtube.com/live/ID
    /youtube\.com\/shorts\/([\w-]{11})/, // youtube.com/shorts/ID
    /youtube\.com\/embed\/([\w-]{11})/, // youtube.com/embed/ID
  ];
  for (const re of patterns) {
    const m = input.match(re);
    if (m) return m[1];
  }
  // Bare 11-char video ID (not a UC... channel ID)
  if (/^[\w-]{11}$/.test(input) && !input.startsWith('UC')) return input;
  return null;
}

async function addChannel(inputValue) {
  const raw = inputValue.trim();
  if (!raw) return;

  if (!hasApiAccess()) {
    showToast('Set your API key first', 'error');
    return;
  }

  // Parse the input — could be:
  //   https://www.youtube.com/channel/UCxxxx
  //   https://www.youtube.com/@Handle
  //   @Handle
  //   UCxxxx...  (raw channel ID)

  let channelId = null;
  let handle = null;
  let name = '';

  // Extract video ID from all known YouTube URL formats:
  //   youtube.com/watch?v=ID
  //   youtube.com/live/ID
  //   youtu.be/ID
  //   youtube.com/shorts/ID (just in case)
  const videoIdFromUrl = extractYouTubeVideoId(raw);

  // Other URL patterns
  const channelUrlMatch = raw.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  // @Handle/live means the channel's live page — treat as handle
  const handleLiveMatch = raw.match(/youtube\.com\/@([\w.-]+)\/live/i);
  const handleUrlMatch = !handleLiveMatch && raw.match(/youtube\.com\/@([\w.-]+)/i);
  const idMatch = raw.match(/^UC[\w-]{20,}$/);
  const handleRawMatch = !idMatch && raw.match(/^@([\w.-]+)$/);

  try {
    if (videoIdFromUrl) {
      // Pasted a live stream URL (any format) — resolve channel from the video
      showToast('Looking up channel from stream URL…', 'info');
      const info = await resolveVideoId(videoIdFromUrl);
      if (!info) throw new Error('Video not found — it may be private or deleted');
      channelId = info.channelId;
      name = info.name;
      // If the stream is still live, pre-fill the video ID so it shows instantly
      if (info.isLive) {
        var prefilledVideoId = videoIdFromUrl;
      }
    } else if (idMatch) {
      channelId = raw;
    } else if (channelUrlMatch) {
      channelId = channelUrlMatch[1];
    } else if (handleLiveMatch) {
      handle = '@' + handleLiveMatch[1];
      name = handleLiveMatch[1];
      showToast(`Resolving ${handle}…`, 'info');
      channelId = await resolveHandle(handleLiveMatch[1]);
      if (!channelId) throw new Error('Channel not found');
    } else if (handleUrlMatch) {
      handle = '@' + handleUrlMatch[1];
      name = handleUrlMatch[1];
      showToast(`Resolving ${handle}…`, 'info');
      channelId = await resolveHandle(handleUrlMatch[1]);
      if (!channelId) throw new Error('Channel not found');
    } else if (handleRawMatch) {
      handle = '@' + handleRawMatch[1];
      name = handleRawMatch[1];
      showToast(`Resolving ${handle}…`, 'info');
      channelId = await resolveHandle(handleRawMatch[1]);
      if (!channelId) throw new Error('Channel not found');
    } else {
      showToast('Could not parse — try pasting the full YouTube URL', 'error');
      return;
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    return;
  }

  // Duplicate check
  if (channels.some(c => c.channelId === channelId)) {
    showToast('Channel already in list', 'info');
    return;
  }

  const newChannel = {
    channelId,
    name: name || handle || channelId,
    handle: handle || null,
    videoId: typeof prefilledVideoId !== 'undefined' ? prefilledVideoId : null,
    isLive: typeof prefilledVideoId !== 'undefined',
    viewers: 0,
  };

  channels.push(newChannel);
  saveChannels();
  renderChannelList();
  showToast(`Added ${newChannel.name}`, 'success');

  if (newChannel.isLive) {
    // Already know it's live from the video URL — show it immediately
    showToast(`${newChannel.name} is LIVE!`, 'success');
    buildGrid();
  } else {
    // Check if it's live right now via search.list
    try {
      const videoId = await fetchLiveVideoId(channelId);
      newChannel.videoId = videoId;
      newChannel.isLive = !!videoId;
      saveChannels();
      if (videoId) {
        showToast(`${newChannel.name} is LIVE!`, 'success');
      }
      buildGrid();
      renderChannelList();
    } catch (err) {
      console.warn('[addChannel live check]', err.message);
    }
  }

}

function removeChannel(channelId) {
  const ch = channels.find(c => c.channelId === channelId);
  channels = channels.filter(c => c.channelId !== channelId);
  // If this was the audio stream, clear it
  if (activeAudioChannel === channelId) {
    activeAudioChannel = null;
    saveActiveAudio();
  }
  saveChannels();
  renderChannelList();
  buildGrid();
  if (ch) showToast(`Removed ${ch.name}`, 'info');
}


// ── Toolbar Setup ─────────────────────────────────────────────────────────
function setupToolbar() {
  document.getElementById('btn-sync').addEventListener('click', syncAllStreams);

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    if (isRefreshing) return;
    await refreshAllChannels();
    buildGrid();
  });

  document.getElementById('btn-manage').addEventListener('click', openModal);
}

// ── Modal ─────────────────────────────────────────────────────────────────
function setupModal() {
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  document.getElementById('btn-add-channel').addEventListener('click', async () => {
    const input = document.getElementById('channel-input');
    const val = input.value.trim();
    if (!val) return;
    input.value = '';
    input.disabled = true;
    document.getElementById('btn-add-channel').disabled = true;
    await addChannel(val);
    input.disabled = false;
    document.getElementById('btn-add-channel').disabled = false;
    input.focus();
  });

  document.getElementById('channel-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-add-channel').click();
  });

  document.getElementById('btn-save-key').addEventListener('click', () => {
    const val = document.getElementById('api-key-input').value.trim();
    if (!val) { showToast('API key cannot be empty', 'error'); return; }
    saveApiKey(val);
    document.getElementById('api-key-section').classList.add('key-set');
    showToast('API key saved', 'success');
    initDashboard();
  });

  // Show masked current key in field
  if (apiKey && apiKey !== 'YOUR_GOOGLE_API_KEY_HERE') {
    document.getElementById('api-key-input').placeholder = '••••••••••••••••' + apiKey.slice(-4);
    document.getElementById('api-key-section').classList.add('key-set');
  }
}

function openModal() {
  renderChannelList();
  // Hide the API key section when the server-side proxy is available.
  // On localhost without `netlify dev`, keep the manual browser key fallback visible.
  document.getElementById('api-key-section').style.display =
    (isLocalHost && !localYoutubeProxyAvailable) ? '' : 'none';
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function renderChannelList() {
  const list = document.getElementById('channel-list');
  if (!list) return;
  if (!channels.length) {
    list.innerHTML = '<li class="no-channels">No channels yet. Add one below.</li>';
    return;
  }

  list.innerHTML = channels.map(ch => `
    <li class="${ch.isLive ? 'is-live' : ''}" data-channel-id="${escAttr(ch.channelId)}">
      <div class="ch-row">
        <div class="ch-status"></div>
        <span class="ch-name" title="${escAttr(ch.channelId)}">${escHtml(ch.name || ch.handle || ch.channelId)}</span>
        ${ch.isLive ? '<span class="ch-live-tag">● LIVE</span>' : ''}
        <button class="btn-set-url" title="Manually set live stream URL">🔗</button>
        <button class="btn-remove-ch" title="Remove channel">&times;</button>
      </div>
      <div class="ch-url-row hidden">
        <input class="ch-url-input" type="text" placeholder="Paste live stream URL (youtube.com/watch?v=...)">
        <button class="btn-url-confirm">Set</button>
      </div>
    </li>
  `).join('');

  list.querySelectorAll('.btn-remove-ch').forEach(btn => {
    btn.addEventListener('click', () => removeChannel(btn.closest('li').dataset.channelId));
  });

  list.querySelectorAll('.btn-set-url').forEach(btn => {
    btn.addEventListener('click', () => {
      const urlRow = btn.closest('li').querySelector('.ch-url-row');
      urlRow.classList.toggle('hidden');
      if (!urlRow.classList.contains('hidden')) urlRow.querySelector('.ch-url-input').focus();
    });
  });

  list.querySelectorAll('.btn-url-confirm').forEach(btn => {
    btn.addEventListener('click', () => {
      const li    = btn.closest('li');
      const input = li.querySelector('.ch-url-input');
      setStreamUrl(li.dataset.channelId, input.value.trim());
      input.value = '';
      li.querySelector('.ch-url-row').classList.add('hidden');
    });
  });

  list.querySelectorAll('.ch-url-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.closest('li').querySelector('.btn-url-confirm').click();
      if (e.key === 'Escape') input.closest('li').querySelector('.ch-url-row').classList.add('hidden');
    });
  });
}

function setStreamUrl(channelId, url) {
  if (!url) return;
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) { showToast('Could not extract video ID — paste the full YouTube URL', 'error'); return; }
  const ch = channels.find(c => c.channelId === channelId);
  if (!ch) return;
  ch.videoId  = videoId;
  ch.isLive   = true;
  ch.manualVideoId = true; // flag: search.list unreliable for this channel
  saveChannels();
  renderChannelList();
  buildGrid();
  showToast(`${ch.name} stream set — loading now`, 'success');
}

// ── UI Helpers ────────────────────────────────────────────────────────────
function updateLiveCount() {
  const count = channels.filter(c => c.isLive && c.videoId).length;
  const el = document.getElementById('live-count');
  if (!el) return;
  el.textContent = count > 0 ? `${count} LIVE` : '— LIVE';
  el.classList.toggle('has-live', count > 0);
}

function formatViewers(n) {
  if (!n || n === 0) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K watching`;
  return `${n} watching`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3000);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ── Tab Switching ─────────────────────────────────────────────────────────
// Lives here because it controls the whole page layout, not just backtest.
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  const isLive     = tab === 'live';
  const isBacktest = tab === 'backtest';
  const isStats    = tab === 'stats';
  const isCourse   = tab === 'course';

  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.getElementById('grid-container').classList.toggle('hidden', !isLive);
  document.getElementById('backtest-panel').classList.toggle('hidden', !isBacktest);
  document.getElementById('stats-panel').classList.toggle('hidden', !isStats);
  document.getElementById('course-panel').classList.toggle('hidden', !isCourse);

  ['btn-sync', 'btn-refresh'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isLive ? '' : 'none';
  });

  if (isBacktest) {
    if (typeof populateChannelSelect === 'function') populateChannelSelect();
    if (typeof populatePairSelect    === 'function') populatePairSelect();
  }
  if (isStats  && typeof onStatsTabActivated  === 'function') onStatsTabActivated();
  if (isCourse && typeof onCourseTabActivated === 'function') onCourseTabActivated();
}
