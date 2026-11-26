'use strict';

// Past (ended) livestreams viewer — browse a channel's older streams and play them.
const PAST_EMBED_BASE = 'https://www.youtube.com/embed/';
const PAST_STATE = { channelId: null, nextToken: null, loading: false };

document.addEventListener('DOMContentLoaded', setupPast);

function setupPast() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.getElementById('past-channel-select').addEventListener('change', e => {
    loadPastStreams(e.target.value, false);
  });
  document.getElementById('btn-past-more').addEventListener('click', () => {
    loadPastStreams(PAST_STATE.channelId, true);
  });
}

function switchTab(tab) {
  const isLive = tab === 'live';
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.getElementById('grid-container').classList.toggle('hidden', !isLive);
  document.getElementById('past-panel').classList.toggle('hidden', isLive);
  ['btn-sync', 'btn-refresh'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isLive ? '' : 'none';
  });
  if (!isLive) populatePastChannels();
}

function populatePastChannels() {
  const select = document.getElementById('past-channel-select');
  const previous = select.value;
  select.innerHTML = channels
    .map(c => `<option value="${escAttr(c.channelId)}">${escHtml(c.name)}</option>`)
    .join('');
  if (!channels.length) {
    document.getElementById('past-stream-list').innerHTML = '';
    return;
  }
  if (channels.some(c => c.channelId === previous)) select.value = previous;
  if (PAST_STATE.channelId !== select.value) loadPastStreams(select.value, false);
}

async function loadPastStreams(channelId, append) {
  if (!channelId || PAST_STATE.loading) return;
  PAST_STATE.loading = true;
  const list = document.getElementById('past-stream-list');
  const moreBtn = document.getElementById('btn-past-more');
  if (!append) {
    PAST_STATE.channelId = channelId;
    PAST_STATE.nextToken = null;
    list.innerHTML = '';
  }
  try {
    let url = `/.netlify/functions/past-streams?channelId=${encodeURIComponent(channelId)}`;
    if (append && PAST_STATE.nextToken) url += `&pageToken=${encodeURIComponent(PAST_STATE.nextToken)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    PAST_STATE.nextToken = data.nextPageToken || null;
    renderPastStreams(data.streams || []);
    if (!append && !(data.streams || []).length) list.innerHTML = '<li class="past-item-date">No past streams found</li>';
  } catch (err) {
    showToast(`Past streams: ${err.message}`, 'error');
  } finally {
    PAST_STATE.loading = false;
    moreBtn.classList.toggle('hidden', !PAST_STATE.nextToken);
  }
}

function renderPastStreams(streams) {
  const list = document.getElementById('past-stream-list');
  streams.forEach(s => {
    const li = document.createElement('li');
    li.className = 'past-item';
    li.dataset.videoId = s.videoId;
    li.innerHTML = `
      ${s.thumbnail ? `<img src="${escAttr(s.thumbnail)}" alt="" loading="lazy">` : ''}
      <div>
        <div class="past-item-title">${escHtml(s.title)}</div>
        <div class="past-item-date">${escHtml(new Date(s.publishedAt).toLocaleDateString())}</div>
      </div>`;
    li.addEventListener('click', () => playPastStream(s, li));
    list.appendChild(li);
  });
}

function playPastStream(stream, li) {
  document.querySelectorAll('.past-item.active').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('past-player-title').textContent = stream.title;
  document.getElementById('past-frame').src =
    `${PAST_EMBED_BASE}${encodeURIComponent(stream.videoId)}?autoplay=1&rel=0`;
}
