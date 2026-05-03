/**
 * Netlify function — fetch past completed livestreams for a channel
 *
 * Uses YouTube Data API v3 (search endpoint). Results cached in NeonDB
 * for 30 days — old streams never change, so one API call per page per month.
 *
 * Cache hit  → return DB data, 0 quota used
 * Cache miss → fetch from YouTube API, store in DB, costs 100 units
 *
 * GET /.netlify/functions/past-streams?channelId=UC...
 * GET /.netlify/functions/past-streams?channelId=UC...&pageToken=TOKEN
 * GET /.netlify/functions/past-streams?channelId=UC...&bust=1   ← force refresh
 */

const { neon } = require('@neondatabase/serverless');

const YT_API_BASE  = 'https://www.googleapis.com/youtube/v3';
const PAGE0_TTL_MS = 12 * 60 * 60 * 1000;       // 12 hours — picks up new daily streams
const OLDER_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days  — old streams never change

function isQuotaError(data) {
  return data?.error?.errors?.some(e => e.reason === 'quotaExceeded');
}

async function ytFetch(url, apiKeys) {
  let lastRes, lastData;
  for (let i = 0; i < apiKeys.length; i++) {
    url.searchParams.set('key', apiKeys[i]);
    const res  = await fetch(url.toString());
    const data = await res.json();
    lastRes  = res;
    lastData = data;
    if (res.status === 403 && isQuotaError(data)) {
      console.warn(`[past-streams] key ${i + 1} quota exceeded — trying next`);
      continue;
    }
    return { res, data };
  }
  return { res: lastRes, data: lastData };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const apiKeys = [
    process.env.YOUTUBE_API_KEY,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
    process.env.YOUTUBE_API_KEY_4,
  ].filter(Boolean);
  if (!apiKeys.length) return respond(500, { error: 'No YOUTUBE_API_KEY set' });

  const { channelId, pageToken, bust } = event.queryStringParameters || {};
  if (!channelId) return respond(400, { error: 'channelId is required' });

  const isFirstPage = !pageToken;
  const cacheKey    = `past-streams__${channelId}__${pageToken || 'page1'}`;
  const ttl         = isFirstPage ? PAGE0_TTL_MS : OLDER_TTL_MS;

  try {
    const sql = neon(process.env.DATABASE_URL);

    // ── Cache check ──────────────────────────────────────────────────────
    if (!bust) {
      const rows = await sql`SELECT value, updated_at FROM dashboard_state WHERE key = ${cacheKey}`;
      if (rows.length) {
        const age = Date.now() - new Date(rows[0].updated_at).getTime();
        if (age < ttl) {
          console.log(`[past-streams] cache hit ${cacheKey} (${Math.round(age / 3600000)}h old)`);
          return respond(200, { ...rows[0].value, cached: true });
        }
      }
    }

    // ── Cache miss — fetch from YouTube (100 quota units) ────────────────
    const searchUrl = new URL(`${YT_API_BASE}/search`);
    searchUrl.searchParams.set('part', 'id,snippet');
    searchUrl.searchParams.set('channelId', channelId);
    searchUrl.searchParams.set('eventType', 'completed');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('order', 'date');
    searchUrl.searchParams.set('maxResults', '20');
    if (pageToken) searchUrl.searchParams.set('pageToken', pageToken);

    const { res, data } = await ytFetch(searchUrl, apiKeys);

    if (!res.ok) {
      const msg = data?.error?.message || `YouTube API error ${res.status}`;
      return respond(res.status, { error: msg });
    }

    const streams = (data.items || []).map(item => ({
      videoId:     item.id.videoId,
      title:       item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      thumbnail:   item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
    }));

    const payload = { streams, nextPageToken: data.nextPageToken || null };

    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES (${cacheKey}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    console.log(`[past-streams] fetched & cached ${cacheKey} (${streams.length} streams)`);

    return respond(200, { ...payload, cached: false });

  } catch (err) {
    console.error('[past-streams]', err);
    return respond(502, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
