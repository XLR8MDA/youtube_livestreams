/**
 * Netlify function — global custom currency pairs list
 *
 * GET    /.netlify/functions/custom-pairs               → returns pairs array
 * POST   /.netlify/functions/custom-pairs               → add { label, value }
 * DELETE /.netlify/functions/custom-pairs?value=EURGBP  → remove by value
 */

const { neon } = require('@neondatabase/serverless');

const STATE_KEY = 'custom-pairs';

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

async function getPairs(sql) {
  const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${STATE_KEY}`;
  return Array.isArray(rows[0]?.value) ? rows[0].value : [];
}

async function savePairs(sql, pairs) {
  await sql`
    INSERT INTO dashboard_state (key, value)
    VALUES (${STATE_KEY}, ${JSON.stringify(pairs)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL is not set' });

  try {
    const sql = await getDb();

    if (event.httpMethod === 'GET') {
      return respond(200, await getPairs(sql));
    }

    if (event.httpMethod === 'POST') {
      const { label, value } = JSON.parse(event.body || '{}');
      if (!label || !value) return respond(400, { error: 'label and value are required' });
      const pairs = await getPairs(sql);
      if (pairs.some(p => p.value === value)) return respond(200, { ok: true, pairs });
      const updated = [...pairs, { label: String(label).slice(0, 40), value: String(value).slice(0, 20) }];
      await savePairs(sql, updated);
      return respond(200, { ok: true, pairs: updated });
    }

    if (event.httpMethod === 'DELETE') {
      const val = event.queryStringParameters?.value;
      if (!val) return respond(400, { error: 'value query param required' });
      const pairs = await getPairs(sql);
      const updated = pairs.filter(p => p.value !== val);
      await savePairs(sql, updated);
      return respond(200, { ok: true, pairs: updated });
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
