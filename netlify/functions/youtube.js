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

function isQuotaError(data) {
  return data?.error?.errors?.some(e => e.reason === 'quotaExceeded');
}

exports.handler = async (event) => {
  const apiKeys = [
    process.env.YOUTUBE_API_KEY,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
  ].filter(Boolean);

  console.log('[youtube fn] keys available:', apiKeys.length, '| method:', event.httpMethod);

  if (!apiKeys.length) {
    console.error('[youtube fn] No YOUTUBE_API_KEY set in environment variables');
    return respond(500, { error: 'YOUTUBE_API_KEY environment variable is not set' });
  }

  // Health check — GET with no endpoint param
  const params = event.queryStringParameters || {};
  if (!params.endpoint) {
    return respond(200, { ok: true, keyPresent: true });
  }

  const { endpoint, ...ytParams } = params;

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return respond(400, { error: `Invalid endpoint. Allowed: ${[...ALLOWED_ENDPOINTS].join(', ')}` });
  }

  let lastStatus, lastData;
  for (let i = 0; i < apiKeys.length; i++) {
    const url = new URL(`${YT_API_BASE}/${endpoint}`);
    Object.entries(ytParams).forEach(([k, v]) => url.searchParams.set(k, v));
    url.searchParams.set('key', apiKeys[i]);

    try {
      const res = await fetch(url.toString());
      const data = await res.json();
      lastStatus = res.status;
      lastData = data;

      if (res.status === 403 && isQuotaError(data)) {
        console.warn(`[youtube fn] Key ${i + 1} quota exceeded — trying next key`);
        continue;
      }
      return respond(res.status, data);
    } catch (err) {
      return respond(502, { error: `Upstream request failed: ${err.message}` });
    }
  }

  // All keys exhausted
  console.error('[youtube fn] All API keys quota exceeded');
  return respond(lastStatus, lastData);
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
