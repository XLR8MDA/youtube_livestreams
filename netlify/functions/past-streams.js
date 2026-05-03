/**
 * Netlify function — fetch past completed livestreams for a channel
 *
 * GET /.netlify/functions/past-streams?channelId=UC...&pageToken=...
 *
 * Response: { streams: [{ videoId, title, publishedAt, thumbnail }], nextPageToken }
 *
 * Results are cached in NeonDB (dashboard_state) for 6 hours to avoid burning
 * YouTube search quota (100 units per call).
 */

const { neon } = require('@neondatabase/serverless');

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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
      console.warn(`[past-streams] Key ${i + 1} quota exceeded — trying next key`);
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
  ].filter(Boolean);
  if (!apiKeys.length) return respond(500, { error: 'YOUTUBE_API_KEY not set' });

  const { channelId, pageToken, bust } = event.queryStringParameters || {};
  if (!channelId) return respond(400, { error: 'channelId is required' });

  const cacheKey = `past-streams__${channelId}__${pageToken || 'page1'}`;

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Check cache (skip if bust=1 is passed)
    if (!bust) {
      const rows = await sql`SELECT value, updated_at FROM dashboard_state WHERE key = ${cacheKey}`;
      if (rows.length) {
        const age = Date.now() - new Date(rows[0].updated_at).getTime();
        if (age < CACHE_TTL_MS) {
          console.log(`[past-streams] cache hit for ${cacheKey} (age ${Math.round(age / 60000)}min)`);
          return respond(200, { ...rows[0].value, cached: true });
        }
      }
    }

    // Cache miss — fetch from YouTube (costs 100 quota units)
    const searchUrl = new URL(`${YT_API_BASE}/search`);
    searchUrl.searchParams.set('part', 'id,snippet');
    searchUrl.searchParams.set('channelId', channelId);
    searchUrl.searchParams.set('eventType', 'completed');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('order', 'date');
    searchUrl.searchParams.set('maxResults', '10');
    if (pageToken) searchUrl.searchParams.set('pageToken', pageToken);

    const { res, data } = await ytFetch(searchUrl, apiKeys);

    if (!res.ok) {
      const msg = data?.error?.message || `YouTube API error ${res.status}`;
      return respond(res.status, { error: msg });
    }

    const streams = (data.items || []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
    }));

    const payload = { streams, nextPageToken: data.nextPageToken || null };

    // Store in cache
    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES (${cacheKey}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    console.log(`[past-streams] cached ${cacheKey} (${streams.length} streams)`);

    return respond(200, { ...payload, cached: false });
  } catch (err) {
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
