/**
 * Netlify serverless function — YouTube API proxy
 * Keeps YOUTUBE_API_KEY server-side so it never reaches the browser.
 *
 * Usage from frontend:
 *   GET /.netlify/functions/youtube?endpoint=search&part=id&channelId=UC...
 *
 * Allowed endpoints: search, videos, channels
 */

const ALLOWED_ENDPOINTS = new Set(['search', 'videos', 'channels']);
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

exports.handler = async (event) => {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    return respond(500, { error: 'YOUTUBE_API_KEY environment variable is not set' });
  }

  const params = event.queryStringParameters || {};
  const { endpoint, ...ytParams } = params;

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return respond(400, { error: `Invalid endpoint. Allowed: ${[...ALLOWED_ENDPOINTS].join(', ')}` });
  }

  const url = new URL(`${YT_API_BASE}/${endpoint}`);
  Object.entries(ytParams).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('key', apiKey);

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    return respond(res.status, data);
  } catch (err) {
    return respond(502, { error: `Upstream request failed: ${err.message}` });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
