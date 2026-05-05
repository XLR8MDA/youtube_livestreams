'use strict';

let statsLoaded = false;

document.addEventListener('DOMContentLoaded', initStatsDashboard);

function initStatsDashboard() {
  document.getElementById('btn-stats-refresh').addEventListener('click', () => {
    statsLoaded = false;
    loadStatsDashboard();
  });

  document.getElementById('btn-close-ch-daily').addEventListener('click', closeChDaily);
  document.getElementById('ch-daily-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeChDaily();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeChDaily();
  });
}

function closeChDaily() {
  document.getElementById('ch-daily-overlay').classList.add('hidden');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' });
}

async function openChDaily(channelId, channelName) {
  const overlay = document.getElementById('ch-daily-overlay');
  const status  = document.getElementById('ch-daily-status');
  const table   = document.getElementById('ch-daily-table');

  document.getElementById('ch-daily-title').textContent = channelName;
  document.getElementById('ch-daily-summary').textContent = '';
  status.innerHTML = '<p>Loading…</p>';
  status.classList.remove('hidden');
  table.classList.add('hidden');
  overlay.classList.remove('hidden');

  try {
    const res  = await fetch(`/.netlify/functions/channel-daily?channelId=${encodeURIComponent(channelId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const days   = data.days   || [];
    const trades = data.trades || [];

    if (!trades.length) {
      status.innerHTML = '<p>No journal entries found for this channel.</p>';
      return;
    }

    // Summary line in header
    const totalTrades = trades.length;
    const totalWins   = trades.filter(t => t.result === 'win').length;
    const rrVals      = trades.filter(t => t.rr != null).map(t => t.rr);
    const avgRR       = rrVals.length ? (rrVals.reduce((a, b) => a + b, 0) / rrVals.length).toFixed(2) : null;
    const wr          = totalTrades ? ((totalWins / totalTrades) * 100).toFixed(1) : null;
    document.getElementById('ch-daily-summary').textContent =
      [totalTrades + ' trades', wr != null ? wr + '% WR' : null, avgRR ? avgRR + 'R avg' : null].filter(Boolean).join('  ·  ');

    // Build table rows grouped by date
    const tbody = table.querySelector('tbody');
    let html = '';
    let lastDate = null;

    for (const t of trades) {
      if (t.date !== lastDate) {
        const day = days.find(d => d.date === t.date);
        const summary = day
          ? ` — ${day.trades} trade${day.trades !== 1 ? 's' : ''}  ${day.winRate != null ? day.winRate + '%' : ''}  ${day.avgRR != null ? day.avgRR + 'R' : ''}  W${day.wins} L${day.losses} BE${day.be}`.trim()
          : '';
        html += `<tr class="ch-date-group-row"><td colspan="9">${fmtDate(t.date)}${esc(summary)}</td></tr>`;
        lastDate = t.date;
      }

      const result = t.result || '';
      const videoLink = t.streamId
        ? `<a class="ch-daily-vid-link" href="https://youtube.com/watch?v=${esc(t.streamId)}${t.videoTimestamp != null ? '&t=' + t.videoTimestamp + 's' : ''}" target="_blank" rel="noopener" title="${esc(t.streamTitle || '')}">▶</a>`
        : '';

      let rrDisplay = '—';
      let rrClass = 'ch-cell-rr';
      if (t.rr != null) {
        if (result === 'loss') {
          rrDisplay = `-${Math.abs(t.rr)}R`;
          rrClass += ' negative';
        } else if (result === 'win') {
          rrDisplay = `+${t.rr}R`;
          rrClass += ' positive';
        } else {
          rrDisplay = `${t.rr}R`;
        }
      }

      html += `
        <tr class="ch-row-${result}">
          <td>${esc(t.pair || '—')}</td>
          <td class="ch-cell-${(t.direction || '').toLowerCase()}">${esc((t.direction || '—').toUpperCase())}</td>
          <td class="ch-cell-${(result || '').toLowerCase()}">${result.toUpperCase() || '—'}</td>
          <td>${t.entry != null ? t.entry : '—'}</td>
          <td>${t.stop  != null ? t.stop  : '—'}</td>
          <td>${t.exit  != null ? t.exit  : '—'}</td>
          <td class="${rrClass}">${rrDisplay}</td>
          <td class="ch-cell-notes">${esc(t.notes || '')}</td>
          <td>${videoLink}</td>
        </tr>`;
    }

    tbody.innerHTML = html;
    status.classList.add('hidden');
    table.classList.remove('hidden');
  } catch (err) {
    status.innerHTML = `<p>Failed to load: ${esc(err.message)}</p>`;
  }
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
    renderStatsQuarters(Array.isArray(data.quarters) ? data.quarters : []);
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

function renderStatsQuarters(rows) {
  const tbody = document.querySelector('#stats-quarter-table tbody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="stats-empty-cell">No quarterly data yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(row => `
    <tr>
      <td><strong>${esc(row.label)}</strong></td>
      <td>${row.trades}</td>
      <td>${fmtPct(row.winRate)}</td>
      <td>${fmtRR(row.avgRR)}</td>
      <td class="stats-win">${row.wins}</td>
      <td class="stats-loss">${row.losses}</td>
      <td class="stats-be">${row.be}</td>
    </tr>
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
      <tr class="ch-row-clickable" data-channel-id="${esc(row.channelId)}" data-channel-name="${esc(label)}" title="Click to see daily breakdown">
        <td>${esc(label)}</td>
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

  tbody.querySelectorAll('tr.ch-row-clickable').forEach(tr => {
    tr.addEventListener('click', () => openChDaily(tr.dataset.channelId, tr.dataset.channelName));
  });
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
