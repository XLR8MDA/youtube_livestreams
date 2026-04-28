/**
 * Netlify function — persistent channel storage via NeonDB (Relational)
 *
 * GET  /.netlify/functions/channels   → returns channels array
 * POST /.netlify/functions/channels   → saves channels array (body: JSON array)
 */

const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  // Ensure table exists (Phase 3)
  await sql`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id   TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      handle       TEXT,
      pair         TEXT,
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      manual_video_id BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) {
    return respond(500, { error: 'DATABASE_URL is not set' });
  }

  try {
    const sql = await getDb();

    if (event.httpMethod === 'GET') {
      const rows = await sql`SELECT * FROM channels WHERE is_active = TRUE ORDER BY name ASC`;
      // Map to frontend expected shape
      const channels = rows.map(r => ({
        channelId: r.channel_id,
        name: r.name,
        handle: r.handle,
        pair: r.pair,
        manualVideoId: r.manual_video_id
      }));
      return respond(200, channels);
    }

    if (event.httpMethod === 'POST') {
      const incoming = JSON.parse(event.body || '[]');
      if (!Array.isArray(incoming)) return respond(400, { error: 'Body must be a JSON array' });
      
      const incomingIds = incoming.map(c => c.channelId);
      
      // Remove those not in the incoming list (standard sync behavior for app.js)
      if (incomingIds.length > 0) {
        await sql`DELETE FROM channels WHERE channel_id != ALL(${incomingIds})`;
      } else {
        await sql`DELETE FROM channels`;
      }
      
      // Upsert incoming
      for (const ch of incoming) {
        await sql`
          INSERT INTO channels (channel_id, name, handle, pair, manual_video_id)
          VALUES (${ch.channelId}, ${ch.name}, ${ch.handle || null}, ${ch.pair || null}, ${ch.manualVideoId || false})
          ON CONFLICT (channel_id) DO UPDATE SET
            name = EXCLUDED.name,
            handle = EXCLUDED.handle,
            pair = EXCLUDED.pair,
            manual_video_id = EXCLUDED.manual_video_id,
            updated_at = NOW()
        `;
      }
      
      return respond(200, { ok: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[channels]', err.message);
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
