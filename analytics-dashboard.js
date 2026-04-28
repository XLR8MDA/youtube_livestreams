'use strict';

let statsLoaded = false;

document.addEventListener('DOMContentLoaded', initStatsDashboard);

function initStatsDashboard() {
  document.getElementById('btn-stats-refresh').addEventListener('click', () => {
    statsLoaded = false;
    loadStatsDashboard();
  });
}

function onStatsTabActivated() {
  if (!statsLoaded) loadStatsDashboard();
}

async function loadStatsDashboard() {
  setStatsState('loading');

  try {
    const res = await fetch('/.netlify/functions/journal-dashboard');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Analytics function not available locally. Restart `netlify dev` so `/.netlify/functions/journal-dashboard` is mounted.');
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    renderStatsCards(data.totals || {});
    renderStatsChannels(Array.isArray(data.channels) ? data.channels : []);
    renderStatsPairs(Array.isArray(data.pairs) ? data.pairs : []);
    setStatsState('ready');
    statsLoaded = true;
  } catch (err) {
    setStatsState('error', `Failed to load analytics: ${err.message}`);
  }
}

function setStatsState(state, message) {
  const status = document.getElementById('stats-status');
  const content = document.getElementById('stats-content');

  if (state === 'ready') {
    status.classList.add('hidden');
    content.classList.remove('hidden');
    return;
  }

  content.classList.add('hidden');
  status.classList.remove('hidden');

  const icons = { loading: '&#128200;', error: '&#9888;', empty: '&#128200;' };
  const texts = {
    loading: 'Loading performance data…',
    error: message || 'Analytics could not be loaded.',
    empty: message || 'No journal data yet.',
  };

  status.innerHTML = `
    <div class="big-icon">${icons[state] || '&#128200;'}</div>
    <p>${texts[state]}</p>
  `;
}

function renderStatsCards(totals) {
  const cards = document.getElementById('stats-cards');
  const items = [
    { label: 'Trades', value: totals.trades ?? 0, tone: '' },
    { label: 'Win Rate', value: fmtPct(totals.winRate), tone: 'green' },
    { label: 'Avg R:R', value: fmtRR(totals.avgRR), tone: 'teal' },
    { label: 'Wins', value: totals.wins ?? 0, tone: 'green' },
    { label: 'Losses', value: totals.losses ?? 0, tone: 'red' },
    { label: 'BE', value: totals.be ?? 0, tone: 'amber' },
  ];

  cards.innerHTML = items.map(item => `
    <div class="stats-kpi ${item.tone}">
      <div class="stats-kpi-label">${esc(item.label)}</div>
      <div class="stats-kpi-value">${esc(String(item.value))}</div>
    </div>
  `).join('');
}

function renderStatsChannels(rows) {
  const tbody = document.querySelector('#stats-channel-table tbody');
  const channelMap = new Map((typeof channels !== 'undefined' ? channels : []).map(ch => [ch.channelId, ch]));

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="stats-empty-cell">No channel analytics yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const label = channelMap.get(row.channelId)?.name || channelMap.get(row.channelId)?.handle || row.channelId;
    return `
      <tr>
        <td title="${esc(row.channelId)}">${esc(label)}</td>
        <td>${row.trades}</td>
        <td>${fmtPct(row.winRate)}</td>
        <td>${fmtRR(row.avgRR)}</td>
        <td class="stats-win">${row.wins}</td>
        <td class="stats-loss">${row.losses}</td>
        <td class="stats-be">${row.be}</td>
        <td title="${esc((row.pairs || []).join(', '))}">${esc((row.pairs || []).slice(0, 3).join(', ') || '—')}</td>
      </tr>
    `;
  }).join('');
}

function renderStatsPairs(rows) {
  const tbody = document.querySelector('#stats-pair-table tbody');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="stats-empty-cell">No pair analytics yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${esc(row.pair)}</td>
      <td>${row.trades}</td>
      <td>${fmtPct(row.winRate)}</td>
      <td>${fmtRR(row.avgRR)}</td>
      <td class="stats-win">${row.wins}</td>
      <td class="stats-loss">${row.losses}</td>
      <td class="stats-be">${row.be}</td>
    </tr>
  `).join('');
}

function fmtPct(value) {
  return value == null ? '—' : `${value}%`;
}

function fmtRR(value) {
  return value == null ? '—' : `${value}R`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
