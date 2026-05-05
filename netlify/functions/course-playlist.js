'use strict';

const { neon } = require('@neondatabase/serverless');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchAllPlaylistItems(playlistId, apiKey) {
  const items = [];
  let pageToken = '';

  do {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `YouTube API HTTP ${res.status}`);
    }
    const data = await res.json();

    for (const item of data.items || []) {
      const snippet = item.snippet;
      const videoId = snippet?.resourceId?.videoId;
      if (!videoId) continue;
      items.push({
        videoId,
        title:     snippet.title || '',
        thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
        position:  snippet.position ?? items.length,
      });
    }

    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const playlistId = event.queryStringParameters?.playlistId;
  if (!playlistId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'playlistId required' }) };
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'YOUTUBE_API_KEY not set' }) };
  }

  if (!process.env.DATABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DATABASE_URL not set' }) };
  }

  const sql = neon(process.env.DATABASE_URL);
  const cacheKey = `course-playlist-${playlistId}`;

  // Check cache
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS dashboard_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const rows = await sql`
      SELECT value, updated_at FROM dashboard_state WHERE key = ${cacheKey}
    `;
    if (rows.length > 0) {
      const age = Date.now() - new Date(rows[0].updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ cached: true, items: rows[0].value.items || [] }),
        };
      }
    }
  } catch {}

  // Fetch from YouTube
  try {
    const items = await fetchAllPlaylistItems(playlistId, apiKey);

    // Write to cache
    try {
      await sql`
        INSERT INTO dashboard_state (key, value, updated_at)
        VALUES (${cacheKey}, ${JSON.stringify({ items })}::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
    } catch {}

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ cached: false, items }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
