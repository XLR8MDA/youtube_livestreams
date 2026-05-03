/**
 * Temporary debug function — DELETE after fixing past-streams.
 *
 * GET /.netlify/functions/debug-streams?channelId=UC...
 *
 * Returns raw YouTube API response + DB cache state so we can see
 * exactly what's happening.
 */

const { neon } = require('@neondatabase/serverless');
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

exports.handler = async (event) => {
  const { channelId } = event.queryStringParameters || {};
  if (!channelId) return r(400, { error: 'channelId is required' });

  const apiKeys = [
    process.env.YOUTUBE_API_KEY,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
    process.env.YOUTUBE_API_KEY_4,
  ].filter(Boolean);

  const report = {
    channelId,
    keysAvailable: apiKeys.length,
    dbCache: null,
    ytRawResponse: null,
    error: null,
  };

  // Check DB cache
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT key, updated_at, value->>'streams' as stream_count
      FROM dashboard_state
      WHERE key LIKE ${'past-streams__' + channelId + '__%'}
      ORDER BY key
    `;
    report.dbCache = rows.map(r => ({
      key: r.key,
      updatedAt: r.updated_at,
      streamCount: JSON.parse(r.stream_count || '[]').length,
    }));
  } catch (e) {
    report.dbCache = { error: e.message };
  }

  // Call YouTube API directly and return raw response
  try {
    const url = new URL(`${YT_API_BASE}/search`);
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('channelId', channelId);
    url.searchParams.set('eventType', 'completed');
    url.searchParams.set('type', 'video');
    url.searchParams.set('order', 'date');
    url.searchParams.set('maxResults', '5');
    url.searchParams.set('key', apiKeys[0]);

    const res  = await fetch(url.toString());
    const data = await res.json();
    report.ytStatus     = res.status;
    report.ytRawResponse = data;
  } catch (e) {
    report.error = e.message;
  }

  return r(200, report);
};

function r(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body, null, 2),
  };
}
