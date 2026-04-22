/**
 * Netlify function — trade journal CRUD for backtest sessions
 *
 * GET    /.netlify/functions/journal?channelId=UC...&streamId=videoId
 * POST   /.netlify/functions/journal  { channelId, streamId, streamTitle, entry: {...} }
 * PATCH  /.netlify/functions/journal  { channelId, streamId, entryId, updates: {...} }
 * DELETE /.netlify/functions/journal?channelId=UC...&streamId=...&entryId=...
 */

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  let store;
  try {
    store = getStore('dashboard');
  } catch (err) {
    console.error('[journal] getStore failed:', err.message);
    return respond(500, { error: `Blob store unavailable: ${err.message}` });
  }

  const params = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      return await handleGet(store, params);
    }
    if (event.httpMethod === 'POST') {
      return await handlePost(store, event.body);
    }
    if (event.httpMethod === 'PATCH') {
      return await handlePatch(store, event.body);
    }
    if (event.httpMethod === 'DELETE') {
      return await handleDelete(store, params);
    }
    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[journal] unhandled error:', err.message);
    return respond(500, { error: err.message });
  }
};

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleGet(store, params) {
  const { channelId, streamId } = params;
  if (!channelId || !streamId) {
    return respond(400, { error: 'channelId and streamId are required' });
  }
  const entries = await blobGet(store, blobKey(channelId, streamId));
  return respond(200, entries);
}

async function handlePost(store, rawBody) {
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { channelId, streamId, streamTitle, entry } = body;
  if (!channelId || !streamId || !entry) {
    return respond(400, { error: 'channelId, streamId and entry are required' });
  }

  const newEntry = { id: generateId(), ...entry, createdAt: new Date().toISOString() };
  const entries  = await blobGet(store, blobKey(channelId, streamId));
  entries.push(newEntry);
  await blobSet(store, blobKey(channelId, streamId), entries);
  await updateIndex(store, channelId, streamId, streamTitle || streamId, entries.length);

  return respond(200, { ok: true, id: newEntry.id });
}

async function handlePatch(store, rawBody) {
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { channelId, streamId, entryId, updates } = body;
  if (!channelId || !streamId || !entryId || !updates) {
    return respond(400, { error: 'channelId, streamId, entryId and updates are required' });
  }

  const entries = await blobGet(store, blobKey(channelId, streamId));
  const idx = entries.findIndex(e => e.id === entryId);
  if (idx === -1) return respond(404, { error: 'Entry not found' });

  entries[idx] = { ...entries[idx], ...updates, id: entryId };
  await blobSet(store, blobKey(channelId, streamId), entries);

  return respond(200, { ok: true });
}

async function handleDelete(store, params) {
  const { channelId, streamId, entryId } = params;
  if (!channelId || !streamId || !entryId) {
    return respond(400, { error: 'channelId, streamId and entryId are required' });
  }

  const entries  = await blobGet(store, blobKey(channelId, streamId));
  const filtered = entries.filter(e => e.id !== entryId);
  await blobSet(store, blobKey(channelId, streamId), filtered);
  await updateIndex(store, channelId, streamId, null, filtered.length);

  return respond(200, { ok: true });
}

// ── Blob helpers (always return safe defaults, never throw) ────────────────

async function blobGet(store, key) {
  try {
    const raw = await store.get(key);            // returns string or null
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[journal] blobGet(${key}) failed:`, err.message);
    return [];
  }
}

async function blobSet(store, key, value) {
  await store.set(key, JSON.stringify(value));
}

async function updateIndex(store, channelId, streamId, streamTitle, entryCount) {
  const key   = `journal-index__${channelId}`;
  const index = await blobGet(store, key);        // already returns [] on error

  const existing = index.find(i => i.streamId === streamId);
  if (existing) {
    existing.entryCount = entryCount;
    if (streamTitle) existing.streamTitle = streamTitle;
  } else if (streamTitle) {
    index.unshift({ streamId, streamTitle, entryCount, date: new Date().toISOString() });
  }

  await blobSet(store, key, index);
}

// ── Utils ─────────────────────────────────────────────────────────────────

function blobKey(channelId, streamId) {
  return `journal__${channelId}__${streamId}`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
