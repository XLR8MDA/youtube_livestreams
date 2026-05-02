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
      last_searched_at   TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE live_state ADD COLUMN IF NOT EXISTS last_searched_at TIMESTAMPTZ`;
  return sql;
}

// Returns true only during active IST trading windows (Mon–Fri enforced by cron)
// Window 1: 9:00 AM – 12:00 PM IST  →  03:30 – 06:30 UTC (210–390 min)
// Window 2: 4:00 PM –  9:00 PM IST  →  10:30 – 15:30 UTC (630–930 min)
function isActiveWindow() {
  const now = new Date();
  const t   = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (t >= 210 && t < 390) || (t >= 630 && t < 930);
}

function isQuotaError(data) {
  return data?.error?.errors?.some(e => e.reason === 'quotaExceeded');
}

async function ytFetch(url, apiKeys) {
  let lastRes, lastData;
  for (let i = 0; i < apiKeys.length; i++) {
    url.searchParams.set('key', apiKeys[i]);
    const res = await fetch(url.toString());
    const data = await res.json();
    lastRes = res;
    lastData = data;
    if (res.status === 403 && isQuotaError(data)) {
      console.warn(`[live-checker] Key ${i + 1} quota exceeded — trying next key`);
      continue;
    }
    return { res, data };
  }
  return { res: lastRes, data: lastData };
}

exports.handler = async (event) => {
  const apiKeys = [
    process.env.YOUTUBE_API_KEY,
    process.env.YOUTUBE_API_KEY_2,
  ].filter(Boolean);
  if (!apiKeys.length || !process.env.DATABASE_URL) {
    console.error('[live-checker] Missing env vars');
    return { statusCode: 500 };
  }

  const isManual = event?.httpMethod === 'GET';
  if (!isManual && !isActiveWindow()) {
    console.log('[live-checker] Outside active window — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'outside-window' }) };
  }

  const sql = await getDb();

  const channels = await sql`SELECT * FROM channels WHERE is_active = TRUE`;
  if (channels.length === 0) return { statusCode: 200 };

  const prevStateRows = await sql`SELECT * FROM live_state`;
  const prevState = {};
  for (const r of prevStateRows) {
    prevState[r.channel_id] = {
      isLive: r.is_live,
      videoId: r.last_video_id,
      streamTitle: r.stream_title,
      lastSearchedAt: r.last_searched_at ? new Date(r.last_searched_at) : null,
    };
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
    try {
      const { data } = await ytFetch(url, apiKeys);
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

  // Search channels with no known videoId — throttled to once every 15 min
  const SEARCH_INTERVAL_MS = 15 * 60 * 1000;
  const withoutVideo = channels.filter(c => !newState[c.channel_id]?.videoId);
  for (const ch of withoutVideo) {
    const lastSearched = prevState[ch.channel_id]?.lastSearchedAt;
    if (!isManual && lastSearched && (Date.now() - lastSearched.getTime()) < SEARCH_INTERVAL_MS) {
      console.log(`[live-checker] Skipping search for ${ch.name} — searched ${Math.round((Date.now() - lastSearched.getTime()) / 60000)}min ago`);
      continue;
    }
    const url = new URL(`${YT_API_BASE}/search`);
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('channelId', ch.channel_id);
    url.searchParams.set('eventType', 'live');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '1');
    try {
      const { data } = await ytFetch(url, apiKeys);
      const item        = data?.items?.[0];
      const videoId     = item?.id?.videoId || null;
      const streamTitle = item?.snippet?.title || null;
      newState[ch.channel_id] = { ...newState[ch.channel_id], isLive: !!videoId, videoId, streamTitle, lastSearchedAt: new Date() };
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
      INSERT INTO live_state (channel_id, is_live, last_video_id, stream_title, last_notified_at, last_searched_at, updated_at)
      VALUES (
        ${ch.channel_id},
        ${s.isLive},
        ${s.videoId},
        ${s.streamTitle},
        ${!wasLive && isNowLive ? new Date().toISOString() : (prevState[ch.channel_id]?.lastNotifiedAt || null)},
        ${s.lastSearchedAt?.toISOString() || prevState[ch.channel_id]?.lastSearchedAt?.toISOString() || null},
        NOW()
      )
      ON CONFLICT (channel_id) DO UPDATE SET
        is_live = EXCLUDED.is_live,
        last_video_id = EXCLUDED.last_video_id,
        stream_title = EXCLUDED.stream_title,
        last_notified_at = EXCLUDED.last_notified_at,
        last_searched_at = EXCLUDED.last_searched_at,
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

  // Try MarkdownV2 first; fall back to plain text if Telegram rejects it
  const mdLines = [
    `🔴 *${escMd(channelName)}* is LIVE\\!`,
    streamTitle  ? `📺 ${escMd(streamTitle)}` : null,
    videoUrl     ? `🎬 [Watch Stream](${videoUrl})` : null,
    dashboardUrl ? `📊 [Open Dashboard](${dashboardUrl})` : null,
  ].filter(Boolean).join('\n');

  const plainLines = [
    `🔴 ${channelName} is LIVE!`,
    streamTitle  ? `📺 ${streamTitle}` : null,
    videoUrl     ? `🎬 ${videoUrl}` : null,
    dashboardUrl ? `📊 ${dashboardUrl}` : null,
  ].filter(Boolean).join('\n');

  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Attempt 1: MarkdownV2
  const res1 = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mdLines, parse_mode: 'MarkdownV2' }),
  });
  const json1 = await res1.json();
  if (json1.ok) {
    console.log(`[live-checker] Telegram sent (MarkdownV2) for ${channelName}`);
    return;
  }

  // Attempt 2: plain text fallback
  console.warn(`[live-checker] MarkdownV2 failed (${json1.description}) — retrying as plain text`);
  const res2 = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: plainLines }),
  });
  const json2 = await res2.json();
  if (json2.ok) {
    console.log(`[live-checker] Telegram sent (plain text) for ${channelName}`);
  } else {
    console.error(`[live-checker] Telegram failed entirely for ${channelName}:`, json2.description);
  }
}

function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
