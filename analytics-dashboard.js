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
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' });
}

async function openChDaily(channelId, channelName) {
  const overlay = document.getElementById('ch-daily-overlay');
  const status  = document.getElementById('ch-daily-status');
  const body    = document.getElementById('ch-daily-body');

  document.getElementById('ch-daily-title').textContent = channelName;
  document.getElementById('ch-daily-summary').innerHTML = '';
  status.style.display = '';
  status.innerHTML = '<p>Loading…</p>';

  // Clear previous day sections
  body.querySelectorAll('.ch-day-section').forEach(el => el.remove());

  overlay.classList.remove('hidden');

  try {
    const res  = await fetch(`/.netlify/functions/channel-daily?channelId=${encodeURIComponent(channelId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const days   = data.days   || [];
    const trades = data.trades || [];

    if (!days.length) {
      status.innerHTML = '<p>No journal entries found for this channel.</p>';
      return;
    }

    // Header summary chips
    const allTrades  = days.reduce((s, d) => s + d.trades, 0);
    const allWins    = days.reduce((s, d) => s + d.wins,   0);
    const totalWR    = allTrades ? Number(((allWins / allTrades) * 100).toFixed(1)) : null;
    const allRR      = trades.filter(t => t.rr != null).map(t => t.rr);
    const avgRR      = allRR.length ? Number((allRR.reduce((a, b) => a + b, 0) / allRR.length).toFixed(2)) : null;
    const allLosses  = days.reduce((s, d) => s + d.losses, 0);

    const summaryEl = document.getElementById('ch-daily-summary');
    summaryEl.innerHTML = [
      `<span class="ch-summary-chip">${allTrades} trade${allTrades !== 1 ? 's' : ''}</span>`,
      totalWR != null ? `<span class="ch-summary-chip ${totalWR >= 50 ? 'green' : 'red'}">${totalWR}% WR</span>` : '',
      avgRR   != null ? `<span class="ch-summary-chip teal">${avgRR}R avg</span>` : '',
    ].join('');

    // Group trades by date
    const byDate = {};
    for (const t of trades) {
      (byDate[t.date] = byDate[t.date] || []).push(t);
    }

    status.style.display = 'none';

    // Render day sections
    for (const d of days) {
      const dayTrades = byDate[d.date] || [];
      const wrClass   = d.winRate == null ? '' : d.winRate >= 50 ? 'wr' : 'wr bad';

      const dirChips = [
        d.longs  ? `<span class="ch-day-chip dir">${d.longs}L</span>`  : '',
        d.shorts ? `<span class="ch-day-chip dir">${d.shorts}S</span>` : '',
      ].join('');

      const tradeCards = dayTrades.map(t => {
        const result = t.result || 'be';
        const videoLink = t.streamId
          ? `<a class="ch-daily-vid-link" href="https://youtube.com/watch?v=${esc(t.streamId)}${t.videoTimestamp != null ? '&t=' + t.videoTimestamp + 's' : ''}" target="_blank" rel="noopener">▶ Watch</a>`
          : '';
        return `
          <div class="ch-trade-card ${result}">
            <div class="ch-trade-badges">
              <span class="ch-badge pair">${esc(t.pair || '—')}</span>
              <span class="ch-badge ${t.direction || ''}">${esc((t.direction || '—').toUpperCase())}</span>
              <span class="ch-badge ${result}">${result.toUpperCase()}</span>
            </div>
            <div class="ch-trade-prices">
              <div class="ch-price-item">
                <span class="ch-price-label">Entry</span>
                <span class="ch-price-value">${t.entry != null ? t.entry : '—'}</span>
              </div>
              <div class="ch-price-item">
                <span class="ch-price-label">Stop</span>
                <span class="ch-price-value">${t.stop != null ? t.stop : '—'}</span>
              </div>
              <div class="ch-price-item">
                <span class="ch-price-label">Exit</span>
                <span class="ch-price-value">${t.exit != null ? t.exit : '—'}</span>
              </div>
              <div class="ch-price-item rr">
                <span class="ch-price-label">R:R</span>
                <span class="ch-price-value">${t.rr != null ? t.rr + 'R' : '—'}</span>
              </div>
            </div>
            <div class="ch-trade-right">
              ${t.notes ? `<div class="ch-trade-notes-text">${esc(t.notes)}</div>` : ''}
              ${videoLink}
            </div>
          </div>`;
      }).join('');

      const section = document.createElement('div');
      section.className = 'ch-day-section';
      section.innerHTML = `
        <div class="ch-day-header">
          <span class="ch-day-arrow">▶</span>
          <span class="ch-day-date">${fmtDate(d.date)}</span>
          <div class="ch-day-chips">
            <span class="ch-day-chip neutral">${d.trades} trade${d.trades !== 1 ? 's' : ''}</span>
            ${d.winRate != null ? `<span class="ch-day-chip ${wrClass}">${d.winRate}%</span>` : ''}
            ${d.avgRR   != null ? `<span class="ch-day-chip rr">${d.avgRR}R</span>` : ''}
            ${d.wins  ? `<span class="ch-day-chip win">W ${d.wins}</span>`  : ''}
            ${d.losses? `<span class="ch-day-chip loss">L ${d.losses}</span>`: ''}
            ${d.be    ? `<span class="ch-day-chip be">BE ${d.be}</span>`    : ''}
            ${dirChips}
          </div>
        </div>
        <div class="ch-day-trades">${tradeCards}</div>`;

      const header     = section.querySelector('.ch-day-header');
      const tradesDiv  = section.querySelector('.ch-day-trades');
      const arrow      = section.querySelector('.ch-day-arrow');

      header.addEventListener('click', () => {
        const open = tradesDiv.classList.toggle('open');
        arrow.classList.toggle('open', open);
      });

      body.appendChild(section);
    }
  } catch (err) {
    status.style.display = '';
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
