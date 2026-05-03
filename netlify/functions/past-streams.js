/**
 * Netlify function — fetch past completed livestreams for a channel
 *
 * Uses YouTube's internal browse API (youtubei/v1/browse) — no YouTube Data API
 * quota consumed. Results cached per page in NeonDB.
 *
 * Page 0 : browseId + streams tab params  → cached 6 h
 * Page 1+: continuation token from prev   → cached 7 days
 *
 * GET /.netlify/functions/past-streams?channelId=UC...
 * GET /.netlify/functions/past-streams?channelId=UC...&pageToken=1
 * GET /.netlify/functions/past-streams?channelId=UC...&bust=1
 */

const { neon } = require('@neondatabase/serverless');

const PAGE0_TTL_MS = 6 * 60 * 60 * 1000;
const OLDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// YouTube internal client context — same values the web player uses
const YT_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20240101.00.00',
  hl: 'en',
  gl: 'US',
};

const YT_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'X-YouTube-Client-Name': '1',
  'X-YouTube-Client-Version': YT_CLIENT.clientVersion,
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
};

// Base64-encoded protobuf param that selects the Streams/Live tab
// Decodes to proto: field 2 = "streams"
const STREAMS_TAB_PARAMS = 'EgdzdHJlYW1z';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const { channelId, pageToken, bust } = event.queryStringParameters || {};
  if (!channelId) return respond(400, { error: 'channelId is required' });

  const page     = parseInt(pageToken || '0', 10);
  const cacheKey = `scraped-streams__${channelId}__${page}`;
  const ttl      = page === 0 ? PAGE0_TTL_MS : OLDER_TTL_MS;

  try {
    const sql = neon(process.env.DATABASE_URL);

    // ── Cache check ──────────────────────────────────────────────────────
    if (!bust) {
      const rows = await sql`SELECT value, updated_at FROM dashboard_state WHERE key = ${cacheKey}`;
      if (rows.length) {
        const age = Date.now() - new Date(rows[0].updated_at).getTime();
        if (age < ttl) {
          const c = rows[0].value;
          console.log(`[past-streams] cache hit page ${page} (${Math.round(age / 60000)}min old)`);
          return respond(200, {
            streams: c.streams,
            nextPageToken: c.continuationToken ? String(page + 1) : null,
            cached: true,
          });
        }
      }
    }

    // ── Fetch from YouTube ───────────────────────────────────────────────
    let result;

    if (page === 0) {
      result = await browseStreamsTab(channelId);
    } else {
      const prevKey  = `scraped-streams__${channelId}__${page - 1}`;
      const prevRows = await sql`SELECT value FROM dashboard_state WHERE key = ${prevKey}`;
      if (!prevRows.length || !prevRows[0].value?.continuationToken) {
        return respond(400, { error: 'Load previous page first — continuation token missing.' });
      }
      result = await fetchContinuation(prevRows[0].value.continuationToken);
    }

    // ── Cache result ─────────────────────────────────────────────────────
    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES (${cacheKey}, ${JSON.stringify(result)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    console.log(`[past-streams] page ${page}: ${result.streams.length} streams, hasMore=${!!result.continuationToken}`);

    return respond(200, {
      streams: result.streams,
      nextPageToken: result.continuationToken ? String(page + 1) : null,
      cached: false,
    });

  } catch (err) {
    console.error('[past-streams]', err.message);
    return respond(502, { error: err.message });
  }
};

// ── YouTube internal browse API ───────────────────────────────────────────

async function browseStreamsTab(channelId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/browse', {
    method: 'POST',
    headers: YT_HEADERS,
    body: JSON.stringify({
      context: { client: YT_CLIENT },
      browseId: channelId,
      params: STREAMS_TAB_PARAMS,
    }),
  });
  if (!res.ok) throw new Error(`YouTube browse returned ${res.status}`);
  const data = await res.json();
  return parseTabData(data);
}

async function fetchContinuation(token) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/browse', {
    method: 'POST',
    headers: YT_HEADERS,
    body: JSON.stringify({
      context: { client: YT_CLIENT },
      continuation: token,
    }),
  });
  if (!res.ok) throw new Error(`YouTube browse continuation returned ${res.status}`);
  const data = await res.json();
  return parseContinuationData(data);
}

// ── Parsers ───────────────────────────────────────────────────────────────

function parseTabData(data) {
  const streams = [];
  let continuationToken = null;

  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];

  function getContents(tr) {
    return tr?.content?.richGridRenderer?.contents
        || tr?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents
        || null;
  }

  let contents = null;

  // 1. Selected tab (should be streams since we passed STREAMS_TAB_PARAMS)
  for (const tab of tabs) {
    const tr = tab?.tabRenderer;
    if (tr?.selected) { contents = getContents(tr); if (contents) break; }
  }

  // 2. Tab whose endpoint URL contains /streams or /live
  if (!contents) {
    for (const tab of tabs) {
      const tr  = tab?.tabRenderer;
      const url = tr?.endpoint?.commandMetadata?.webCommandMetadata?.url || '';
      if (url.includes('/streams') || url.includes('/live')) {
        contents = getContents(tr);
        if (contents) break;
      }
    }
  }

  // 3. Tab titled "Live" or "Streams"
  if (!contents) {
    for (const tab of tabs) {
      const tr    = tab?.tabRenderer;
      const title = (tr?.title || '').toLowerCase();
      if (title === 'live' || title === 'streams') {
        contents = getContents(tr);
        if (contents) break;
      }
    }
  }

  if (!contents) {
    const titles = tabs.map(t => t?.tabRenderer?.title).filter(Boolean);
    console.warn('[past-streams] streams tab not found. Available tabs:', titles);
    return { streams, continuationToken };
  }

  for (const item of contents) {
    const vr = item?.richItemRenderer?.content?.videoRenderer;
    if (vr) {
      const s = parseVideoRenderer(vr);
      if (s) streams.push(s);
    }
    const cont = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (cont) continuationToken = cont;
  }

  return { streams, continuationToken };
}

function parseContinuationData(data) {
  const streams = [];
  let continuationToken = null;

  const actions = data?.onResponseReceivedActions || [];
  for (const action of actions) {
    const items = action?.appendContinuationItemsAction?.continuationItems || [];
    for (const item of items) {
      const vr = item?.richItemRenderer?.content?.videoRenderer;
      if (vr) {
        const s = parseVideoRenderer(vr);
        if (s) streams.push(s);
      }
      const cont = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (cont) continuationToken = cont;
    }
  }

  return { streams, continuationToken };
}

function parseVideoRenderer(vr) {
  const videoId = vr?.videoId;
  if (!videoId) return null;

  // Skip currently-live streams
  const isLive = (vr?.badges || []).some(b => b?.metadataBadgeRenderer?.label === 'LIVE');
  if (isLive) return null;

  const title     = vr?.title?.runs?.[0]?.text || vr?.title?.simpleText || 'Untitled';
  const dateText  = vr?.publishedTimeText?.simpleText || vr?.dateText?.simpleText || null;
  const thumbs    = vr?.thumbnail?.thumbnails || [];
  const thumbnail = thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || null;

  return { videoId, title, publishedAt: dateText, thumbnail };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
