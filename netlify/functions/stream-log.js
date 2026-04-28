/**
 * Netlify function — stream trade log (Relational)
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
  // Ensure table exists (Phase 2)
  await sql`
    CREATE TABLE IF NOT EXISTS stream_log (
      id            BIGSERIAL PRIMARY KEY,
      video_id      TEXT NOT NULL UNIQUE,
      channel_id    TEXT NOT NULL,
      channel_name  TEXT,
      stream_title  TEXT,
      ended_at      TIMESTAMPTZ NOT NULL,
      analyzed_at   TIMESTAMPTZ,
      status        TEXT NOT NULL,
      has_traces    BOOLEAN NOT NULL DEFAULT FALSE,
      marker_count  INTEGER NOT NULL DEFAULT 0,
      markers       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

function mapToFrontend(row) {
  return {
    videoId: row.video_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    streamTitle: row.stream_title,
    endedAt: row.ended_at instanceof Date ? row.ended_at.toISOString() : row.ended_at,
    analyzedAt: row.analyzed_at instanceof Date ? row.analyzed_at.toISOString() : row.analyzed_at,
    status: row.status,
    hasTraces: row.has_traces,
    markerCount: row.marker_count,
    markers: row.markers
  };
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });

  try {
    const sql    = await getDb();
    const params = event.queryStringParameters || {};
    const path   = event.path || '';

    // Debug: pending queue (still from blob for now)
    if (path.endsWith('/pending')) {
      const rows = await sql`SELECT value FROM dashboard_state WHERE key = 'pending-analysis'`;
      const pending = rows.length ? rows[0].value : [];
      return respond(200, pending);
    }

    const days      = Math.min(parseInt(params.days || '30', 10), 90);
    const channelId = params.channelId || null;
    const cutoff    = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let query;
    if (channelId) {
      query = sql`
        SELECT * FROM stream_log 
        WHERE ended_at >= ${cutoff} AND channel_id = ${channelId}
        ORDER BY ended_at DESC
        LIMIT 90
      `;
    } else {
      query = sql`
        SELECT * FROM stream_log 
        WHERE ended_at >= ${cutoff}
        ORDER BY ended_at DESC
        LIMIT 90
      `;
    }
    
    const rows = await query;
    const log = rows.map(mapToFrontend);

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

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
