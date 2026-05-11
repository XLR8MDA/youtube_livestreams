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
      image_url       TEXT,
      video_timestamp INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS image_url TEXT`;
  // MSM fields
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS session TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS timeframe TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS htf_poi TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS choch_confirmed BOOLEAN`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS liquidity_swept BOOLEAN`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS entry_model TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS pullback_depth TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS confirmation_candle TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS candle_quality TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS rr_planned DOUBLE PRECISION`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS risk_percent DOUBLE PRECISION`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS rating INTEGER`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS followed_rules BOOLEAN`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS tradingview_url TEXT`;
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
    imageUrl: row.image_url,
    videoTimestamp: row.video_timestamp,
    createdAt: row.created_at,
    // MSM fields
    session: row.session,
    timeframe: row.timeframe,
    htfPoi: row.htf_poi,
    chochConfirmed: row.choch_confirmed,
    liquiditySwept: row.liquidity_swept,
    entryModel: row.entry_model,
    pullbackDepth: row.pullback_depth,
    confirmationCandle: row.confirmation_candle,
    candleQuality: row.candle_quality,
    rrPlanned: row.rr_planned,
    riskPercent: row.risk_percent,
    rating: row.rating,
    followedRules: row.followed_rules,
    tradingviewUrl: row.tradingview_url,
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
      if (!channelId) return respond(400, { error: 'channelId is required' });

      if (streamId) {
        const rows = await sql`
          SELECT * FROM journal_entries 
          WHERE channel_id = ${channelId} AND stream_id = ${streamId}
          ORDER BY created_at ASC
        `;
        return respond(200, rows.map(mapToFrontend));
      } else {
        // Return index of streams that have journal entries for this channel
        const key = `journal-index__${channelId}`;
        const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${key}`;
        return respond(200, (rows.length && Array.isArray(rows[0].value)) ? rows[0].value : []);
      }
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { channelId, streamId, streamTitle, streamDate, entry } = body;
      if (!channelId || !streamId || !entry) return respond(400, { error: 'channelId, streamId, entry required' });

      const id = generateId();
      const createdAt = streamDate ? new Date(streamDate).toISOString() : new Date().toISOString();

      await sql`
        INSERT INTO journal_entries (
          id, channel_id, stream_id, stream_title, pair, direction, result,
          entry_price, exit_price, stop_price, rr, notes, image_url, video_timestamp, created_at,
          session, timeframe, htf_poi, choch_confirmed, liquidity_swept,
          entry_model, pullback_depth, confirmation_candle, candle_quality,
          rr_planned, risk_percent, rating, followed_rules, tradingview_url
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
          ${entry.imageUrl || null},
          ${entry.videoTimestamp || null},
          ${createdAt},
          ${entry.session || null},
          ${entry.timeframe || null},
          ${entry.htfPoi || null},
          ${entry.chochConfirmed ?? null},
          ${entry.liquiditySwept ?? null},
          ${entry.entryModel || null},
          ${entry.pullbackDepth || null},
          ${entry.confirmationCandle || null},
          ${entry.candleQuality || null},
          ${entry.rrPlanned || null},
          ${entry.riskPercent || null},
          ${entry.rating || null},
          ${entry.followedRules ?? null},
          ${entry.tradingviewUrl || null}
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
        image_url: updates.imageUrl,
        video_timestamp: updates.videoTimestamp,
        session: updates.session,
        timeframe: updates.timeframe,
        htf_poi: updates.htfPoi,
        choch_confirmed: updates.chochConfirmed,
        liquidity_swept: updates.liquiditySwept,
        entry_model: updates.entryModel,
        pullback_depth: updates.pullbackDepth,
        confirmation_candle: updates.confirmationCandle,
        candle_quality: updates.candleQuality,
        rr_planned: updates.rrPlanned,
        risk_percent: updates.riskPercent,
        rating: updates.rating,
        followed_rules: updates.followedRules,
        tradingview_url: updates.tradingviewUrl,
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
      if (fieldsToUpdate.hasOwnProperty('pair')) await sql`UPDATE journal_entries SET pair = ${fieldsToUpdate.pair} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('direction')) await sql`UPDATE journal_entries SET direction = ${fieldsToUpdate.direction} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('result')) await sql`UPDATE journal_entries SET result = ${fieldsToUpdate.result} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('entry_price')) await sql`UPDATE journal_entries SET entry_price = ${fieldsToUpdate.entry_price} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('exit_price')) await sql`UPDATE journal_entries SET exit_price = ${fieldsToUpdate.exit_price} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('stop_price')) await sql`UPDATE journal_entries SET stop_price = ${fieldsToUpdate.stop_price} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('rr')) await sql`UPDATE journal_entries SET rr = ${fieldsToUpdate.rr} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('notes')) await sql`UPDATE journal_entries SET notes = ${fieldsToUpdate.notes} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('image_url')) await sql`UPDATE journal_entries SET image_url = ${fieldsToUpdate.image_url} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('video_timestamp')) await sql`UPDATE journal_entries SET video_timestamp = ${fieldsToUpdate.video_timestamp} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('session')) await sql`UPDATE journal_entries SET session = ${fieldsToUpdate.session} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('timeframe')) await sql`UPDATE journal_entries SET timeframe = ${fieldsToUpdate.timeframe} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('htf_poi')) await sql`UPDATE journal_entries SET htf_poi = ${fieldsToUpdate.htf_poi} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('choch_confirmed')) await sql`UPDATE journal_entries SET choch_confirmed = ${fieldsToUpdate.choch_confirmed} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('liquidity_swept')) await sql`UPDATE journal_entries SET liquidity_swept = ${fieldsToUpdate.liquidity_swept} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('entry_model')) await sql`UPDATE journal_entries SET entry_model = ${fieldsToUpdate.entry_model} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('pullback_depth')) await sql`UPDATE journal_entries SET pullback_depth = ${fieldsToUpdate.pullback_depth} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('confirmation_candle')) await sql`UPDATE journal_entries SET confirmation_candle = ${fieldsToUpdate.confirmation_candle} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('candle_quality')) await sql`UPDATE journal_entries SET candle_quality = ${fieldsToUpdate.candle_quality} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('rr_planned')) await sql`UPDATE journal_entries SET rr_planned = ${fieldsToUpdate.rr_planned} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('risk_percent')) await sql`UPDATE journal_entries SET risk_percent = ${fieldsToUpdate.risk_percent} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('rating')) await sql`UPDATE journal_entries SET rating = ${fieldsToUpdate.rating} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('followed_rules')) await sql`UPDATE journal_entries SET followed_rules = ${fieldsToUpdate.followed_rules} WHERE id = ${entryId}`;
      if (fieldsToUpdate.hasOwnProperty('tradingview_url')) await sql`UPDATE journal_entries SET tradingview_url = ${fieldsToUpdate.tradingview_url} WHERE id = ${entryId}`;

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
