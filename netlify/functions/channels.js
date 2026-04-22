/**
 * Netlify serverless function — persistent channel storage via Netlify Blobs
 *
 * GET  /.netlify/functions/channels   → returns channels array
 * POST /.netlify/functions/channels   → saves channels array (body: JSON array)
 */

const { getStore } = require('@netlify/blobs');

const BLOB_KEY = 'channels';

exports.handler = async (event) => {
  const store = getStore('dashboard');

  if (event.httpMethod === 'GET') {
    try {
      const data = await store.get(BLOB_KEY, { type: 'json' });
      return respond(200, Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[channels fn] GET error:', err.message);
      return respond(500, { error: err.message });
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const channels = JSON.parse(event.body || '[]');
      if (!Array.isArray(channels)) {
        return respond(400, { error: 'Body must be a JSON array' });
      }
      await store.set(BLOB_KEY, JSON.stringify(channels));
      return respond(200, { ok: true });
    } catch (err) {
      console.error('[channels fn] POST error:', err.message);
      return respond(500, { error: err.message });
    }
  }

  return respond(405, { error: 'Method not allowed' });
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
