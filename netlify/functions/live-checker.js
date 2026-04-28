/**
 * Netlify scheduled function — checks all saved channels every 2 minutes,
 * sends a Telegram notification for any channel that just went live.
 *
 * Schedule: set in netlify.toml → [functions."live-checker"] schedule = "*/2 * * * *"
 */

const { neon } = require('@neondatabase/serverless');

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

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

async function dbGet(sql, key, fallback = null) {
  try {
    const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${key}`;
    return rows.length ? rows[0].value : fallback;
  } catch { return fallback; }
}

async function dbSet(sql, key, value) {
  await sql`
    INSERT INTO dashboard_state (key, value)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

exports.handler = async (event) => {
  // Allow manual GET trigger for debugging: /.netlify/functions/live-checker
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !process.env.DATABASE_URL) {
    console.error('[live-checker] Missing env vars: YOUTUBE_API_KEY or DATABASE_URL not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const sql      = await getDb();
  const channels = await dbGet(sql, 'channels', []);
  if (!Array.isArray(channels) || channels.length === 0) {
    console.log('[live-checker] No channels saved');
    return { statusCode: 200 };
  }

  const prevState = await dbGet(sql, 'live-state', {}) || {};
  const newState  = { ...prevState };
  const newlyLive = [];

  // Batch-check channels with a known videoId (1 quota unit)
  const withVideo = channels.filter(c => prevState[c.channelId]?.videoId);
  if (withVideo.length > 0) {
    const ids = withVideo.map(c => prevState[c.channelId].videoId).join(',');
    const url = new URL(`${YT_API_BASE}/videos`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('id', ids);
    url.searchParams.set('key', apiKey);
    try {
      const res  = await fetch(url.toString());
      const data = await res.json();
      const liveMap = new Map((data.items || []).map(item => [
        item.id,
        item.snippet?.liveBroadcastContent === 'live',
      ]));
      for (const ch of withVideo) {
        const videoId   = prevState[ch.channelId].videoId;
        const stillLive = liveMap.get(videoId) ?? false;
        newState[ch.channelId] = { isLive: stillLive, videoId: stillLive ? videoId : null };
      }
    } catch (err) {
      console.warn('[live-checker] batch check failed:', err.message);
    }
  }

  // Search channels with no known videoId (100 quota units each)
  const withoutVideo = channels.filter(c => !newState[c.channelId]?.videoId);
  for (const ch of withoutVideo) {
    const url = new URL(`${YT_API_BASE}/search`);
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('channelId', ch.channelId);
    url.searchParams.set('eventType', 'live');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '1');
    url.searchParams.set('key', apiKey);
    try {
      const res     = await fetch(url.toString());
      const data    = await res.json();
      const item    = data?.items?.[0];
      const videoId = item?.id?.videoId || null;
      const streamTitle = item?.snippet?.title || null;
      newState[ch.channelId] = { isLive: !!videoId, videoId, streamTitle };
    } catch (err) {
      console.warn(`[live-checker] search failed for ${ch.name}:`, err.message);
    }
  }

  // Notify for newly live channels
  const dashboardUrl = process.env.URL || '';
  for (const ch of channels) {
    const wasLive   = prevState[ch.channelId]?.isLive ?? false;
    const isNowLive = newState[ch.channelId]?.isLive ?? false;
    if (!wasLive && isNowLive) newlyLive.push(ch);
  }

  for (const ch of newlyLive) {
    const state = newState[ch.channelId];
    try {
      await sendTelegram({
        channelName:  ch.name || ch.handle || ch.channelId,
        streamTitle:  state?.streamTitle || null,
        videoId:      state?.videoId || null,
        dashboardUrl,
      });
      console.log(`[live-checker] Notified: ${ch.name}`);
    } catch (err) {
      console.warn(`[live-checker] notify failed for ${ch.name}:`, err.message);
    }
  }

  await dbSet(sql, 'live-state', newState);
  console.log(`[live-checker] ${channels.length} checked, ${newlyLive.length} newly live`);
  return { statusCode: 200, body: JSON.stringify({ checked: channels.length, notified: newlyLive.length }) };
};

async function sendTelegram({ channelName, streamTitle, videoId, dashboardUrl }) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[live-checker] Telegram not configured — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
    return;
  }
  const videoUrl = videoId ? `https://youtube.com/watch?v=${videoId}` : null;
  const lines = [
    `🔴 *${escMd(channelName)}* is LIVE\\!`,
    streamTitle ? `📺 ${escMd(streamTitle)}` : null,
    videoUrl    ? `🎬 [Watch Stream](${videoUrl})` : null,
    dashboardUrl ? `📊 [Open Dashboard](${dashboardUrl})` : null,
  ].filter(Boolean).join('\n');

  const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: lines, parse_mode: 'MarkdownV2' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
}

function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
