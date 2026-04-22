/**
 * Netlify function — trade journal CRUD via NeonDB
 *
 * GET    /.netlify/functions/journal?channelId=UC...&streamId=videoId
 * POST   /.netlify/functions/journal  { channelId, streamId, streamTitle, entry }
 * PATCH  /.netlify/functions/journal  { channelId, streamId, entryId, updates }
 * DELETE /.netlify/functions/journal?channelId=UC...&streamId=...&entryId=...
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

async function dbGet(sql, key) {
  const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${key}`;
  if (!rows.length) return [];
  const val = rows[0].value;
  return Array.isArray(val) ? val : [];
}

async function dbSet(sql, key, value) {
  await sql`
    INSERT INTO dashboard_state (key, value)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) {
    return respond(500, { error: 'DATABASE_URL is not set' });
  }

  try {
    const sql    = await getDb();
    const params = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      const { channelId, streamId } = params;
      if (!channelId || !streamId) return respond(400, { error: 'channelId and streamId required' });
      const entries = await dbGet(sql, `journal__${channelId}__${streamId}`);
      return respond(200, entries);
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { channelId, streamId, streamTitle, entry } = body;
      if (!channelId || !streamId || !entry) return respond(400, { error: 'channelId, streamId, entry required' });

      const newEntry = { id: generateId(), ...entry, createdAt: new Date().toISOString() };
      const entries  = await dbGet(sql, `journal__${channelId}__${streamId}`);
      entries.push(newEntry);
      await dbSet(sql, `journal__${channelId}__${streamId}`, entries);
      await updateIndex(sql, channelId, streamId, streamTitle || streamId, entries.length);
      return respond(200, { ok: true, id: newEntry.id });
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const { channelId, streamId, entryId, updates } = body;
      if (!channelId || !streamId || !entryId || !updates) return respond(400, { error: 'channelId, streamId, entryId, updates required' });

      const entries = await dbGet(sql, `journal__${channelId}__${streamId}`);
      const idx = entries.findIndex(e => e.id === entryId);
      if (idx === -1) return respond(404, { error: 'Entry not found' });
      entries[idx] = { ...entries[idx], ...updates, id: entryId };
      await dbSet(sql, `journal__${channelId}__${streamId}`, entries);
      return respond(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const { channelId, streamId, entryId } = params;
      if (!channelId || !streamId || !entryId) return respond(400, { error: 'channelId, streamId, entryId required' });

      const entries  = await dbGet(sql, `journal__${channelId}__${streamId}`);
      const filtered = entries.filter(e => e.id !== entryId);
      await dbSet(sql, `journal__${channelId}__${streamId}`, filtered);
      await updateIndex(sql, channelId, streamId, null, filtered.length);
      return respond(200, { ok: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[journal]', err.message);
    return respond(500, { error: err.message });
  }
};

async function updateIndex(sql, channelId, streamId, streamTitle, entryCount) {
  const index    = await dbGet(sql, `journal-index__${channelId}`);
  const existing = index.find(i => i.streamId === streamId);
  if (existing) {
    existing.entryCount = entryCount;
    if (streamTitle) existing.streamTitle = streamTitle;
  } else if (streamTitle) {
    index.unshift({ streamId, streamTitle, entryCount, date: new Date().toISOString() });
  }
  await dbSet(sql, `journal-index__${channelId}`, index);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
