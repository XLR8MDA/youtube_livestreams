'use strict';

const { neon } = require('@neondatabase/serverless');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS channels (
      id         SERIAL PRIMARY KEY,
      channel_id TEXT UNIQUE NOT NULL,
      name       TEXT,
      handle     TEXT,
      paused     BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!process.env.DATABASE_URL) {
    return {
      statusCode: 503,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Database not configured' }),
    };
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    await ensureTable(sql);

    // ── GET: return all saved channels ──────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const rows = await sql`
        SELECT channel_id, name, handle, paused
        FROM channels
        ORDER BY created_at ASC
      `;
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          channels: rows.map(r => ({
            channelId: r.channel_id,
            name: r.name,
            handle: r.handle,
            paused: r.paused,
          })),
        }),
      };
    }

    // ── POST: upsert all channels ───────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }
      const { channels } = body;
      if (!Array.isArray(channels)) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'channels array required' }) };
      }
      for (const ch of channels) {
        if (!ch.channelId) continue;
        await sql`
          INSERT INTO channels (channel_id, name, handle, paused, updated_at)
          VALUES (${ch.channelId}, ${ch.name || null}, ${ch.handle || null}, ${ch.paused || false}, NOW())
          ON CONFLICT (channel_id) DO UPDATE
            SET name       = EXCLUDED.name,
                handle     = EXCLUDED.handle,
                paused     = EXCLUDED.paused,
                updated_at = NOW()
        `;
      }
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
    }

    // ── DELETE: remove a single channel ────────────────────────────────────
    if (event.httpMethod === 'DELETE') {
      const channelId = event.queryStringParameters?.channelId;
      if (!channelId) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'channelId query param required' }) };
      }
      await sql`DELETE FROM channels WHERE channel_id = ${channelId}`;
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('[channels fn]', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
