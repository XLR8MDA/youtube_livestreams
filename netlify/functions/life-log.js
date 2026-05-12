/**
 * Netlify function — Hourly life log CRUD
 *
 * GET    /.netlify/functions/life-log?date=2026-05-12
 * POST   /.netlify/functions/life-log  { date, hour, activity, category }
 * DELETE /.netlify/functions/life-log?date=2026-05-12&hour=9
 */

const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS life_logs (
      id          TEXT PRIMARY KEY,
      log_date    DATE NOT NULL,
      hour        INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
      activity    TEXT,
      category    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (log_date, hour)
    )
  `;
  return sql;
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });

  try {
    const sql    = await getDb();
    const params = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      const { date, year, month } = params;

      // Month range query — returns all logs grouped by date
      if (year && month) {
        const from = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
        const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const rows = await sql`
          SELECT log_date::text AS date, hour, activity, category
          FROM life_logs
          WHERE log_date >= ${from} AND log_date <= ${to}
          ORDER BY log_date, hour ASC
        `;
        return respond(200, rows);
      }

      // Single day query
      if (!date) return respond(400, { error: 'date or year+month required' });
      const rows = await sql`
        SELECT hour, activity, category
        FROM life_logs
        WHERE log_date = ${date}
        ORDER BY hour ASC
      `;
      return respond(200, rows);
    }

    if (event.httpMethod === 'POST') {
      const { date, hour, activity, category } = JSON.parse(event.body || '{}');
      if (!date || hour == null) return respond(400, { error: 'date and hour required' });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await sql`
        INSERT INTO life_logs (id, log_date, hour, activity, category)
        VALUES (${id}, ${date}, ${hour}, ${activity || null}, ${category || null})
        ON CONFLICT (log_date, hour) DO UPDATE
          SET activity = EXCLUDED.activity,
              category = EXCLUDED.category
      `;
      return respond(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const { date, hour } = params;
      if (!date || hour == null) return respond(400, { error: 'date and hour required' });
      await sql`DELETE FROM life_logs WHERE log_date = ${date} AND hour = ${parseInt(hour)}`;
      return respond(200, { ok: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[life-log]', err.message);
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
