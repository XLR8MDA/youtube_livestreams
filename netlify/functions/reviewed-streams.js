/**
 * Netlify function — reviewed stream tracking
 *
 * GET    /.netlify/functions/reviewed-streams?channelId=UC...
 *        → { videoIds: [...] }
 *        Returns union of: streams with journal entries + manually reviewed streams
 *
 * POST   /.netlify/functions/reviewed-streams
 *        body: { videoId, channelId }
 *        → { ok: true }
 *
 * DELETE /.netlify/functions/reviewed-streams?videoId=...&channelId=...
 *        → { ok: true }
 */

const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS reviewed_streams (
      video_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      reviewed_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (video_id, channel_id)
    )
  `;
  return sql;
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) {
    return respond(500, { error: 'DATABASE_URL is not set' });
  }

  try {
    const sql    = await getDb();
    const params = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      const { channelId } = params;
      if (!channelId) return respond(400, { error: 'channelId required' });

      const rows = await sql`
        SELECT DISTINCT video_id FROM (
          SELECT stream_id AS video_id
          FROM   journal_entries
          WHERE  channel_id = ${channelId}
            AND  stream_id IS NOT NULL AND stream_id <> ''
          UNION
          SELECT video_id
          FROM   reviewed_streams
          WHERE  channel_id = ${channelId}
        ) combined
      `;

      return respond(200, { videoIds: rows.map(r => r.video_id) });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { videoId, channelId } = body;
      if (!videoId || !channelId) return respond(400, { error: 'videoId and channelId required' });

      await sql`
        INSERT INTO reviewed_streams (video_id, channel_id)
        VALUES (${videoId}, ${channelId})
        ON CONFLICT (video_id, channel_id) DO NOTHING
      `;

      return respond(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const { videoId, channelId } = params;
      if (!videoId || !channelId) return respond(400, { error: 'videoId and channelId required' });

      await sql`
        DELETE FROM reviewed_streams
        WHERE video_id = ${videoId} AND channel_id = ${channelId}
      `;

      return respond(200, { ok: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[reviewed-streams]', err.message);
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
