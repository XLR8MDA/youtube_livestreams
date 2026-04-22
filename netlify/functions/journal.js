/**
 * Netlify function — trade journal CRUD for backtest sessions
 *
 * GET    /.netlify/functions/journal?channelId=UC...&streamId=videoId
 *        → returns all journal entries for a stream
 *
 * POST   /.netlify/functions/journal
 *        Body: { channelId, streamId, streamTitle, entry: { direction, entry, exit, result, rr, notes, videoTimestamp } }
 *        → adds entry, returns { ok: true, id: "uuid" }
 *
 * DELETE /.netlify/functions/journal?channelId=UC...&streamId=videoId&entryId=uuid
 *        → removes entry, returns { ok: true }
 *
 * PATCH  /.netlify/functions/journal
 *        Body: { channelId, streamId, entryId, updates: { ...fields } }
 *        → edits entry, returns { ok: true }
 *
 * Blob keys:
 *   journal__{channelId}__{streamId}  → array of journal entries
 *   journal-index__{channelId}        → array of { streamId, streamTitle, entryCount, date }
 */

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const store = getStore('dashboard');
  const params = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    const { channelId, streamId } = params;
    if (!channelId || !streamId) return respond(400, { error: 'channelId and streamId required' });

    const entries = await store.get(blobKey(channelId, streamId), { type: 'json' }).catch(() => []);
    return respond(200, Array.isArray(entries) ? entries : []);
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

    const { channelId, streamId, streamTitle, entry } = body;
    if (!channelId || !streamId || !entry) return respond(400, { error: 'channelId, streamId, entry required' });

    const newEntry = {
      id: generateId(),
      ...entry,
      createdAt: new Date().toISOString(),
    };

    const entries = await store.get(blobKey(channelId, streamId), { type: 'json' }).catch(() => []) || [];
    entries.push(newEntry);
    await store.set(blobKey(channelId, streamId), JSON.stringify(entries));

    await updateIndex(store, channelId, streamId, streamTitle || streamId, entries.length);

    return respond(200, { ok: true, id: newEntry.id });
  }

  if (event.httpMethod === 'DELETE') {
    const { channelId, streamId, entryId } = params;
    if (!channelId || !streamId || !entryId) return respond(400, { error: 'channelId, streamId, entryId required' });

    const entries = await store.get(blobKey(channelId, streamId), { type: 'json' }).catch(() => []) || [];
    const filtered = entries.filter(e => e.id !== entryId);
    await store.set(blobKey(channelId, streamId), JSON.stringify(filtered));

    await updateIndex(store, channelId, streamId, null, filtered.length);

    return respond(200, { ok: true });
  }

  if (event.httpMethod === 'PATCH') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

    const { channelId, streamId, entryId, updates } = body;
    if (!channelId || !streamId || !entryId || !updates) return respond(400, { error: 'channelId, streamId, entryId, updates required' });

    const entries = await store.get(blobKey(channelId, streamId), { type: 'json' }).catch(() => []) || [];
    const idx = entries.findIndex(e => e.id === entryId);
    if (idx === -1) return respond(404, { error: 'Entry not found' });

    entries[idx] = { ...entries[idx], ...updates, id: entryId };
    await store.set(blobKey(channelId, streamId), JSON.stringify(entries));

    return respond(200, { ok: true });
  }

  return respond(405, { error: 'Method not allowed' });
};

function blobKey(channelId, streamId) {
  return `journal__${channelId}__${streamId}`;
}

async function updateIndex(store, channelId, streamId, streamTitle, entryCount) {
  const indexKey = `journal-index__${channelId}`;
  const index = await store.get(indexKey, { type: 'json' }).catch(() => []) || [];
  const existing = index.find(i => i.streamId === streamId);
  if (existing) {
    existing.entryCount = entryCount;
    if (streamTitle) existing.streamTitle = streamTitle;
  } else if (streamTitle) {
    index.unshift({ streamId, streamTitle, entryCount, date: new Date().toISOString() });
  }
  await store.set(indexKey, JSON.stringify(index));
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
