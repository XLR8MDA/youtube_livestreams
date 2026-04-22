/**
 * Netlify function — fetch past completed livestreams for a channel
 *
 * GET /.netlify/functions/past-streams?channelId=UC...&pageToken=...
 *
 * Response: { streams: [{ videoId, title, publishedAt, thumbnail }], nextPageToken }
 */

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return respond(500, { error: 'YOUTUBE_API_KEY not set' });

  const { channelId, pageToken } = event.queryStringParameters || {};
  if (!channelId) return respond(400, { error: 'channelId is required' });

  try {
    // Search for completed livestreams on this channel (10 per page)
    const searchUrl = new URL(`${YT_API_BASE}/search`);
    searchUrl.searchParams.set('part', 'id,snippet');
    searchUrl.searchParams.set('channelId', channelId);
    searchUrl.searchParams.set('eventType', 'completed');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('order', 'date');
    searchUrl.searchParams.set('maxResults', '10');
    searchUrl.searchParams.set('key', apiKey);
    if (pageToken) searchUrl.searchParams.set('pageToken', pageToken);

    const res = await fetch(searchUrl.toString());
    const data = await res.json();

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

    return respond(200, {
      streams,
      nextPageToken: data.nextPageToken || null,
    });
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
