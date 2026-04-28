/**
 * Netlify function — trade journal CRUD via NeonDB (Relational)
 *
 * GET    /.netlify/functions/journal?channelId=UC...&streamId=videoId
 * POST   /.netlify/functions/journal  { channelId, streamId, streamTitle, entry }
 * PATCH  /.netlify/functions/journal  { channelId, streamId, entryId, updates }
 * DELETE /.netlify/functions/journal?channelId=UC...&streamId=...&entryId=...
 */

const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  // Ensure table exists (Phase 1)
  await sql`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id              TEXT PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      stream_id       TEXT NOT NULL,
      stream_title    TEXT,
      pair            TEXT,
      direction       TEXT NOT NULL,
      result          TEXT NOT NULL,
      entry_price     DOUBLE PRECISION,
      exit_price      DOUBLE PRECISION,
      stop_price      DOUBLE PRECISION,
      rr              DOUBLE PRECISION,
      notes           TEXT,
      video_timestamp INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

function mapToFrontend(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    streamId: row.stream_id,
    streamTitle: row.stream_title,
    pair: row.pair,
    direction: row.direction,
    result: row.result,
    entry: row.entry_price,
    exit: row.exit_price,
    stop: row.stop_price,
    rr: row.rr,
    notes: row.notes,
    videoTimestamp: row.video_timestamp,
    createdAt: row.created_at
  };
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
      
      const rows = await sql`
        SELECT * FROM journal_entries 
        WHERE channel_id = ${channelId} AND stream_id = ${streamId}
        ORDER BY created_at ASC
      `;
      
      return respond(200, rows.map(mapToFrontend));
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { channelId, streamId, streamTitle, entry } = body;
      if (!channelId || !streamId || !entry) return respond(400, { error: 'channelId, streamId, entry required' });

      const id = generateId();
      const createdAt = new Date().toISOString();

      await sql`
        INSERT INTO journal_entries (
          id, channel_id, stream_id, stream_title, pair, direction, result,
          entry_price, exit_price, stop_price, rr, notes, video_timestamp, created_at
        ) VALUES (
          ${id},
          ${channelId},
          ${streamId},
          ${streamTitle || null},
          ${entry.pair || null},
          ${entry.direction},
          ${entry.result},
          ${entry.entry || null},
          ${entry.exit || null},
          ${entry.stop || null},
          ${entry.rr || null},
          ${entry.notes || null},
          ${entry.videoTimestamp || null},
          ${createdAt}
        )
      `;
      
      // Update the legacy index blob for backward compatibility during migration
      await updateLegacyIndex(sql, channelId, streamId, streamTitle || streamId);

      return respond(200, { ok: true, id });
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const { channelId, streamId, entryId, updates } = body;
      if (!channelId || !streamId || !entryId || !updates) return respond(400, { error: 'channelId, streamId, entryId, updates required' });

      // Build dynamic update
      const allowedUpdates = {
        pair: updates.pair,
        direction: updates.direction,
        result: updates.result,
        entry_price: updates.entry,
        exit_price: updates.exit,
        stop_price: updates.stop,
        rr: updates.rr,
        notes: updates.notes,
        video_timestamp: updates.videoTimestamp
      };

      // Filter out undefined
      const fieldsToUpdate = {};
      for (const [k, v] of Object.entries(allowedUpdates)) {
        if (v !== undefined) fieldsToUpdate[k] = v;
      }

      if (Object.keys(fieldsToUpdate).length === 0) {
        return respond(200, { ok: true, message: 'No changes' });
      }

      // Simple implementation of dynamic update for Neon
      // In a real app we'd use a query builder, but here we can just do them one by one or a big query
      // For simplicity and safety with Neon's tagged template, let's do a slightly manual approach
      
      const setClauses = [];
      const values = [];
      let i = 1;
      for (const [k, v] of Object.entries(fieldsToUpdate)) {
        setClauses.push(`${k} = ${v === null ? 'NULL' : `'${v}'`}`); // Dangerous if not careful with types
      }
      
      // Better way to do it with neon serverless:
      // Since it's a small set of fields, I'll just do a series of updates or a more complex query.
      // Wait, I can just fetch, merge, and re-insert if it was JSON, but now it's SQL.
      
      // Let's use the fact that we know all fields
      await sql`
        UPDATE journal_entries SET
          pair = COALESCE(${fieldsToUpdate.pair ?? null}, pair),
          direction = COALESCE(${fieldsToUpdate.direction ?? null}, direction),
          result = COALESCE(${fieldsToUpdate.result ?? null}, result),
          entry_price = COALESCE(${fieldsToUpdate.entry_price ?? null}, entry_price),
          exit_price = COALESCE(${fieldsToUpdate.exit_price ?? null}, exit_price),
          stop_price = COALESCE(${fieldsToUpdate.stop_price ?? null}, stop_price),
          rr = COALESCE(${fieldsToUpdate.rr ?? null}, rr),
          notes = COALESCE(${fieldsToUpdate.notes ?? null}, notes),
          video_timestamp = COALESCE(${fieldsToUpdate.video_timestamp ?? null}, video_timestamp)
        WHERE id = ${entryId}
      `;
      // COALESCE with null might not work as intended for setting to null.
      // Actually, if we want to set something to null, COALESCE(null, existing) keeps existing.
      
      // Let's do it properly by checking which fields are in updates
      if (fieldsToUpdate.hasOwnProperty('pair')) await sql`UPDATE journal_entries SET pair = ${fieldsToUpdate.pair} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('direction')) await sql`UPDATE journal_entries SET direction = ${fieldsToUpdate.direction} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('result')) await sql`UPDATE journal_entries SET result = ${fieldsToUpdate.result} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('entry_price')) await sql`UPDATE journal_entries SET entry_price = ${fieldsToUpdate.entry_price} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('exit_price')) await sql`UPDATE journal_entries SET exit_price = ${fieldsToUpdate.exit_price} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('stop_price')) await sql`UPDATE journal_entries SET stop_price = ${fieldsToUpdate.stop_price} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('rr')) await sql`UPDATE journal_entries SET rr = ${fieldsToUpdate.rr} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('notes')) await sql`UPDATE journal_entries SET notes = ${fieldsToUpdate.notes} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('video_timestamp')) await sql`UPDATE journal_entries SET video_timestamp = ${fieldsToUpdate.video_timestamp} WHERE id = ${entryId}`;

      return respond(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const { channelId, streamId, entryId } = params;
      if (!channelId || !streamId || !entryId) return respond(400, { error: 'channelId, streamId, entryId required' });

      await sql`DELETE FROM journal_entries WHERE id = ${entryId}`;
      
      // Update legacy index
      await updateLegacyIndex(sql, channelId, streamId, null);

      return respond(200, { ok: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[journal]', err.message);
    return respond(500, { error: err.message });
  }
};

async function updateLegacyIndex(sql, channelId, streamId, streamTitle) {
  try {
    const countRows = await sql`SELECT COUNT(*) as count FROM journal_entries WHERE channel_id = ${channelId} AND stream_id = ${streamId}`;
    const entryCount = parseInt(countRows[0].count);

    const key = `journal-index__${channelId}`;
    const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${key}`;
    let index = (rows.length && Array.isArray(rows[0].value)) ? rows[0].value : [];
    
    const existing = index.find(i => i.streamId === streamId);
    if (existing) {
      existing.entryCount = entryCount;
      if (streamTitle) existing.streamTitle = streamTitle;
      if (entryCount === 0) {
        index = index.filter(i => i.streamId !== streamId);
      }
    } else if (streamTitle && entryCount > 0) {
      index.unshift({ streamId, streamTitle, entryCount, date: new Date().toISOString() });
    }

    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES (${key}, ${JSON.stringify(index)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  } catch (err) {
    console.error('[journal-index-sync]', err.message);
  }
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
