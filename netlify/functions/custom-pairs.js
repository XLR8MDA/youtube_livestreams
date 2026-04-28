/**
 * Netlify function — global custom currency pairs list (Relational)
 *
 * GET    /.netlify/functions/custom-pairs               → returns pairs array
 * POST   /.netlify/functions/custom-pairs               → add { label, value }
 * DELETE /.netlify/functions/custom-pairs?value=EURGBP  → remove by value
 */

const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  // Ensure table exists (Phase 3)
  await sql`
    CREATE TABLE IF NOT EXISTS custom_pairs (
      id           BIGSERIAL PRIMARY KEY,
      label        TEXT NOT NULL,
      value        TEXT NOT NULL UNIQUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL is not set' });

  try {
    const sql = await getDb();

    if (event.httpMethod === 'GET') {
      const rows = await sql`SELECT label, value FROM custom_pairs ORDER BY label ASC`;
      return respond(200, rows);
    }

    if (event.httpMethod === 'POST') {
      const { label, value } = JSON.parse(event.body || '{}');
      if (!label || !value) return respond(400, { error: 'label and value are required' });
      
      await sql`
        INSERT INTO custom_pairs (label, value)
        VALUES (${String(label).slice(0, 40)}, ${String(value).slice(0, 20).toUpperCase()})
        ON CONFLICT (value) DO UPDATE SET label = EXCLUDED.label
      `;
      
      const rows = await sql`SELECT label, value FROM custom_pairs ORDER BY label ASC`;
      return respond(200, { ok: true, pairs: rows });
    }

    if (event.httpMethod === 'DELETE') {
      const val = event.queryStringParameters?.value;
      if (!val) return respond(400, { error: 'value query param required' });
      
      await sql`DELETE FROM custom_pairs WHERE value = ${val.toUpperCase()}`;
      
      const rows = await sql`SELECT label, value FROM custom_pairs ORDER BY label ASC`;
      return respond(200, { ok: true, pairs: rows });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[custom-pairs]', err.message);
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
