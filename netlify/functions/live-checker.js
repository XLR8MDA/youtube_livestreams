/**
 * Netlify scheduled function — adaptive polling based on IST time windows. (Relational)
 */

const { neon } = require('@neondatabase/serverless');

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  // Ensure tables exist (Phase 4)
  await sql`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id   TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      handle       TEXT,
      pair         TEXT,
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      manual_video_id BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS live_state (
      channel_id         TEXT PRIMARY KEY,
      is_live            BOOLEAN NOT NULL DEFAULT FALSE,
      last_video_id      TEXT,
      stream_title       TEXT,
      last_notified_at   TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

// Returns required minimum gap (minutes) between actual checks based on IST time
function getCheckIntervalMinutes() {
  const now = new Date();
  const t   = now.getUTCHours() * 60 + now.getUTCMinutes(); // minutes since UTC midnight

  // London Open: 10:30 AM – 2:00 PM IST  →  05:00 – 08:30 UTC
  if (t >= 300 && t < 510)  return 5;
  // New York Open: 5:30 PM – 9:30 PM IST  →  12:00 – 16:00 UTC
  if (t >= 720 && t < 960) return 5;
  
  // All other hours
  return 30;
}

exports.handler = async (event) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !process.env.DATABASE_URL) {
    console.error('[live-checker] Missing env vars');
    return { statusCode: 500 };
  }

  const sql      = await getDb();
  const interval = getCheckIntervalMinutes();

  const isManual = event?.httpMethod === 'GET';
  if (!isManual) {
    const rows = await sql`SELECT value FROM dashboard_state WHERE key = 'live-checker-last-run'`;
    const lastRun = rows.length ? rows[0].value : null;
    if (lastRun) {
      const msSinceLast = Date.now() - new Date(lastRun).getTime();
      const minSinceLast = msSinceLast / 60_000;
      if (minSinceLast < interval - 0.5) {
        console.log(`[live-checker] Skipping — off-peak, ${minSinceLast.toFixed(1)}min since last run`);
        return { statusCode: 200, body: JSON.stringify({ skipped: true, interval }) };
      }
    }
    await sql`
      INSERT INTO dashboard_state (key, value) VALUES ('live-checker-last-run', ${JSON.stringify(new Date().toISOString())}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }

  const channels = await sql`SELECT * FROM channels WHERE is_active = TRUE`;
  if (channels.length === 0) return { statusCode: 200 };

  const prevStateRows = await sql`SELECT * FROM live_state`;
  const prevState = {};
  for (const r of prevStateRows) {
    prevState[r.channel_id] = { isLive: r.is_live, videoId: r.last_video_id, streamTitle: r.stream_title };
  }
  
  const newState  = { ...prevState };
  const newlyLive = [];

  // Batch-check channels with a known videoId
  const withVideo = channels.filter(c => prevState[c.channel_id]?.videoId);
  if (withVideo.length > 0) {
    const ids = withVideo.map(c => prevState[c.channel_id].videoId).join(',');
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
        const videoId   = prevState[ch.channel_id].videoId;
        const stillLive = liveMap.get(videoId) ?? false;
        newState[ch.channel_id] = { ...newState[ch.channel_id], isLive: stillLive, videoId: stillLive ? videoId : null };
      }
    } catch (err) {
      console.warn('[live-checker] batch check failed:', err.message);
    }
  }

  // Search channels with no known videoId
  const withoutVideo = channels.filter(c => !newState[c.channel_id]?.videoId);
  for (const ch of withoutVideo) {
    const url = new URL(`${YT_API_BASE}/search`);
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('channelId', ch.channel_id);
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
      newState[ch.channel_id] = { isLive: !!videoId, videoId, streamTitle };
    } catch (err) {
      console.warn(`[live-checker] search failed for ${ch.name}:`, err.message);
    }
  }

  // Notify and Sync state
  const dashboardUrl = process.env.URL || '';
  for (const ch of channels) {
    const wasLive   = prevState[ch.channel_id]?.isLive ?? false;
    const isNowLive = newState[ch.channel_id]?.isLive ?? false;
    if (!wasLive && isNowLive) newlyLive.push(ch);
    
    // Update live_state table
    const s = newState[ch.channel_id];
    await sql`
      INSERT INTO live_state (channel_id, is_live, last_video_id, stream_title, last_notified_at, updated_at)
      VALUES (
        ${ch.channel_id},
        ${s.isLive},
        ${s.videoId},
        ${s.streamTitle},
        ${!wasLive && isNowLive ? new Date().toISOString() : (prevState[ch.channel_id]?.lastNotifiedAt || null)},
        NOW()
      )
      ON CONFLICT (channel_id) DO UPDATE SET
        is_live = EXCLUDED.is_live,
        last_video_id = EXCLUDED.last_video_id,
        stream_title = EXCLUDED.stream_title,
        last_notified_at = EXCLUDED.last_notified_at,
        updated_at = NOW()
    `;
  }

  for (const ch of newlyLive) {
    const state = newState[ch.channel_id];
    await sendTelegram({
      channelName: ch.name,
      streamTitle: state?.streamTitle,
      videoId: state?.videoId,
      dashboardUrl,
    }).catch(err => console.warn(`[live-checker] notify failed:`, err.message));
  }

  // Detection of ended streams
  const justEnded = channels.filter(ch => {
    const wasLive   = prevState[ch.channel_id]?.isLive ?? false;
    const isNowLive = newState[ch.channel_id]?.isLive  ?? false;
    return wasLive && !isNowLive && prevState[ch.channel_id]?.videoId;
  });

  if (justEnded.length > 0) {
    const rows = await sql`SELECT value FROM dashboard_state WHERE key = 'pending-analysis'`;
    const pending = rows.length ? rows[0].value : [];
    const pendingIds = new Set(pending.map(p => p.videoId));
    for (const ch of justEnded) {
      const videoId = prevState[ch.channel_id].videoId;
      if (!pendingIds.has(videoId)) {
        pending.push({
          videoId,
          channelId: ch.channel_id,
          channelName: ch.name,
          streamTitle: prevState[ch.channel_id]?.streamTitle,
          endedAt: new Date().toISOString(),
        });
      }
    }
    await sql`
      INSERT INTO dashboard_state (key, value) VALUES ('pending-analysis', ${JSON.stringify(pending)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }

  return { statusCode: 200, body: JSON.stringify({ checked: channels.length, notified: newlyLive.length, ended: justEnded.length }) };
};

async function sendTelegram({ channelName, streamTitle, videoId, dashboardUrl }) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const videoUrl = videoId ? `https://youtube.com/watch?v=${videoId}` : null;
  const lines = [
    `🔴 *${escMd(channelName)}* is LIVE\\!`,
    streamTitle ? `📺 ${escMd(streamTitle)}` : null,
    videoUrl    ? `🎬 [Watch Stream](${videoUrl})` : null,
    dashboardUrl ? `📊 [Open Dashboard](${dashboardUrl})` : null,
  ].filter(Boolean).join('\n');

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: lines, parse_mode: 'MarkdownV2' }),
  });
}

function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
