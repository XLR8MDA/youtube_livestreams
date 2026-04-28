/**
 * Netlify function — stream trade log
 *
 * GET /.netlify/functions/stream-log
 *   Query params (all optional):
 *     days=N        — last N days (default 30, max 90)
 *     channelId=UC… — filter to one channel
 *   Response: [{ date, streams: [entry, …] }]  grouped by day, newest first
 *
 * GET /.netlify/functions/stream-log/pending
 *   Returns current pending-analysis queue (for debugging)
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

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });

  try {
    const sql    = await getDb();
    const params = event.queryStringParameters || {};
    const path   = event.path || '';

    // Debug: pending queue
    if (path.endsWith('/pending')) {
      const pending = await dbGet(sql, 'pending-analysis', []);
      return respond(200, pending);
    }

    const days      = Math.min(parseInt(params.days || '30', 10), 90);
    const channelId = params.channelId || null;
    const cutoff    = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let log = await dbGet(sql, 'stream-log', []) || [];

    // Filter by date and optional channel
    log = log.filter(e => e.endedAt >= cutoff);
    if (channelId) log = log.filter(e => e.channelId === channelId);

    // Group by date (YYYY-MM-DD of endedAt)
    const byDate = new Map();
    for (const entry of log) {
      const date = entry.endedAt.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    }

    // Sort dates newest first
    const grouped = Array.from(byDate.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, streams]) => ({ date, streams }));

    return respond(200, grouped);
  } catch (err) {
    console.error('[stream-log]', err.message);
    return respond(500, { error: err.message });
  }
};

async function dbGet(sql, key, fallback = null) {
  try {
    const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${key}`;
    return rows.length ? rows[0].value : fallback;
  } catch { return fallback; }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
