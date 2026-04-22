/**
 * Netlify function — persistent channel storage via NeonDB
 *
 * GET  /.netlify/functions/channels   → returns channels array
 * POST /.netlify/functions/channels   → saves channels array (body: JSON array)
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
  if (!process.env.DATABASE_URL) {
    return respond(500, { error: 'DATABASE_URL is not set' });
  }

  try {
    const sql = await getDb();

    if (event.httpMethod === 'GET') {
      const rows = await sql`SELECT value FROM dashboard_state WHERE key = 'channels'`;
      const channels = rows.length ? rows[0].value : [];
      return respond(200, Array.isArray(channels) ? channels : []);
    }

    if (event.httpMethod === 'POST') {
      const channels = JSON.parse(event.body || '[]');
      if (!Array.isArray(channels)) return respond(400, { error: 'Body must be a JSON array' });
      await sql`
        INSERT INTO dashboard_state (key, value)
        VALUES ('channels', ${JSON.stringify(channels)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
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
