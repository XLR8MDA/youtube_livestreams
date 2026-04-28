/**
 * Netlify function — aggregate all journal entries into dashboard stats
 *
 * GET /.netlify/functions/journal-dashboard
 * Response:
 * {
 *   totals: { trades, wins, losses, be, winRate, avgRR },
 *   channels: [{ channelId, trades, wins, losses, be, winRate, avgRR, pairs: [] }],
 *   pairs: [{ pair, trades, wins, losses, be, winRate, avgRR }]
 * }
 */

const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS dashboard_state (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  return sql;
}

exports.handler = async () => {
  if (!process.env.DATABASE_URL) {
    return respond(500, { error: 'DATABASE_URL is not set' });
  }

  try {
    const sql = await getDb();
    const rows = await sql`
      SELECT key, value
      FROM dashboard_state
      WHERE key LIKE 'journal__%'
    `;

    const allEntries = [];
    for (const row of rows) {
      const match = /^journal__(.+?)__(.+)$/.exec(row.key || '');
      if (!match) continue;
      const [, channelId, streamId] = match;
      const entries = Array.isArray(row.value) ? row.value : [];
      for (const entry of entries) {
        allEntries.push({ channelId, streamId, ...entry });
      }
    }

    const totals = buildStats(allEntries);
    const channels = groupByKey(allEntries, entry => entry.channelId)
      .map(([channelId, entries]) => ({
        channelId,
        ...buildStats(entries),
        pairs: Array.from(new Set(entries.map(e => e.pair).filter(Boolean))).sort(),
      }))
      .sort((a, b) => b.trades - a.trades || a.channelId.localeCompare(b.channelId));

    const pairs = groupByKey(allEntries.filter(e => e.pair), entry => entry.pair)
      .map(([pair, entries]) => ({
        pair,
        ...buildStats(entries),
      }))
      .sort((a, b) => b.trades - a.trades || a.pair.localeCompare(b.pair));

    return respond(200, { totals, channels, pairs });
  } catch (err) {
    console.error('[journal-dashboard]', err.message);
    return respond(500, { error: err.message });
  }
};

function groupByKey(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Array.from(map.entries());
}

function buildStats(entries) {
  const wins = entries.filter(entry => entry.result === 'win').length;
  const losses = entries.filter(entry => entry.result === 'loss').length;
  const be = entries.filter(entry => entry.result === 'be').length;
  const trades = entries.length;
  const rrValues = entries
    .map(entry => Number(entry.rr))
    .filter(value => Number.isFinite(value));

  return {
    trades,
    wins,
    losses,
    be,
    winRate: trades ? Number(((wins / trades) * 100).toFixed(1)) : null,
    avgRR: rrValues.length
      ? Number((rrValues.reduce((sum, value) => sum + value, 0) / rrValues.length).toFixed(2))
      : null,
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
