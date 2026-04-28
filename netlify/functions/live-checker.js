/**
 * Netlify scheduled function — adaptive polling based on IST time windows.
 * Triggered every 5 min by cron, but self-throttles to save YouTube quota:
 *
 *   Peak   (every  5 min): 6:00–10:00 PM IST  (12:30–16:30 UTC)
 *   Peak   (every  5 min): 10:30 PM–1:00 AM IST (17:00–19:30 UTC)
 *   Off-peak (every 30 min): all other hours
 *
 * Quota impact (5 channels):
 *   Peak hours  ~7.5h/day × 12 runs/h × 500 units = ~45,000 → with fast-poll optimisation ~5,000
 *   Off-peak ~16.5h/day × 2 runs/h  × 500 units = ~16,500 → with fast-poll optimisation ~1,650
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

// Returns required minimum gap (minutes) between actual checks based on IST time
function getCheckIntervalMinutes() {
  const now = new Date();
  const t   = now.getUTCHours() * 60 + now.getUTCMinutes(); // minutes since UTC midnight

  // 6:00 PM – 10:00 PM IST  →  12:30 – 16:30 UTC
  if (t >= 750 && t < 990)  return 5;
  // 10:30 PM – 1:00 AM IST  →  17:00 – 19:30 UTC
  if (t >= 1020 && t < 1170) return 5;
  // All other hours
  return 30;
}

exports.handler = async (event) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !process.env.DATABASE_URL) {
    console.error('[live-checker] Missing env vars: YOUTUBE_API_KEY or DATABASE_URL not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const sql      = await getDb();
  const interval = getCheckIntervalMinutes();

  // Throttle: skip if last run was too recent (off-peak guard)
  const isManual = event?.httpMethod === 'GET'; // manual HTTP trigger bypasses throttle
  if (!isManual) {
    const lastRun = await dbGet(sql, 'live-checker-last-run', null);
    if (lastRun) {
      const msSinceLast = Date.now() - new Date(lastRun).getTime();
      const minSinceLast = msSinceLast / 60_000;
      if (minSinceLast < interval - 0.5) { // 0.5 min tolerance for cron jitter
        console.log(`[live-checker] Skipping — off-peak, only ${minSinceLast.toFixed(1)}min since last run (interval=${interval}min)`);
        return { statusCode: 200, body: JSON.stringify({ skipped: true, interval }) };
      }
    }
    await dbSet(sql, 'live-checker-last-run', new Date().toISOString());
  }

  console.log(`[live-checker] Running — interval=${interval}min (${interval === 5 ? 'peak' : 'off-peak'})`);

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

  // Detect streams that just ended (true → false) and queue them for analysis
  const justEnded = channels.filter(ch => {
    const wasLive   = prevState[ch.channelId]?.isLive ?? false;
    const isNowLive = newState[ch.channelId]?.isLive  ?? false;
    return wasLive && !isNowLive && prevState[ch.channelId]?.videoId;
  });

  if (justEnded.length > 0) {
    const pending   = await dbGet(sql, 'pending-analysis', []) || [];
    const pendingIds = new Set(pending.map(p => p.videoId));
    for (const ch of justEnded) {
      const videoId = prevState[ch.channelId].videoId;
      if (!pendingIds.has(videoId)) {
        pending.push({
          videoId,
          channelId:   ch.channelId,
          channelName: ch.name || ch.handle || ch.channelId,
          streamTitle: prevState[ch.channelId]?.streamTitle || null,
          endedAt:     new Date().toISOString(),
        });
        console.log(`[live-checker] Queued ended stream for analysis: ${ch.name} — ${videoId}`);
      }
    }
    await dbSet(sql, 'pending-analysis', pending);
  }

  await dbSet(sql, 'live-state', newState);
  console.log(`[live-checker] ${channels.length} checked, ${newlyLive.length} newly live, ${justEnded.length} ended`);
  return { statusCode: 200, body: JSON.stringify({ checked: channels.length, notified: newlyLive.length, ended: justEnded.length }) };
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
