/**
 * Netlify function — fetch past completed livestreams for a channel
 *
 * Scrapes YouTube's channel streams page directly — zero API quota used.
 * Results cached per page in NeonDB.
 *
 * Page 0: scraped fresh, cached 6 hours
 * Page 1+: continuation from previous page, cached 7 days (old streams don't change)
 *
 * GET /.netlify/functions/past-streams?channelId=UC...
 * GET /.netlify/functions/past-streams?channelId=UC...&pageToken=1   ← Load More
 * GET /.netlify/functions/past-streams?channelId=UC...&bust=1        ← force refresh
 *
 * Response: { streams: [{ videoId, title, publishedAt, thumbnail }], nextPageToken }
 */

const { neon } = require('@neondatabase/serverless');

const PAGE0_TTL_MS = 6 * 60 * 60 * 1000;       // 6 hours for newest page
const OLDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days for older pages

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

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
          const cached = rows[0].value;
          console.log(`[past-streams] cache hit page ${page} (age ${Math.round(age / 60000)}min)`);
          return respond(200, {
            streams: cached.streams,
            nextPageToken: cached.continuationToken ? String(page + 1) : null,
            cached: true,
          });
        }
      }
    }

    // ── Cache miss — scrape YouTube ──────────────────────────────────────
    // Resolve scrape URL: prefer @handle format, fall back to /channel/UC...
    const chanRows = await sql`SELECT handle FROM channels WHERE channel_id = ${channelId} LIMIT 1`;
    const handle   = chanRows[0]?.handle?.replace(/^@/, '');
    const streamsUrl = handle
      ? `https://www.youtube.com/@${handle}/streams`
      : `https://www.youtube.com/channel/${channelId}/streams`;

    let result;

    if (page === 0) {
      result = await scrapeChannelStreams(streamsUrl);
    } else {
      // Pull continuation token that was stored when page (page-1) was fetched
      const prevKey  = `scraped-streams__${channelId}__${page - 1}`;
      const prevRows = await sql`SELECT value FROM dashboard_state WHERE key = ${prevKey}`;
      if (!prevRows.length || !prevRows[0].value?.continuationToken) {
        return respond(400, { error: 'Load previous page first — continuation token missing.' });
      }
      result = await fetchContinuation(prevRows[0].value.continuationToken);
    }

    // Store result (streams + continuation token for next Load More)
    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES (${cacheKey}, ${JSON.stringify(result)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    console.log(`[past-streams] scraped page ${page} via ${streamsUrl || 'continuation'}: ${result.streams.length} streams, hasMore=${!!result.continuationToken}`);

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

// ── Scraping ──────────────────────────────────────────────────────────────

async function scrapeChannelStreams(streamsUrl) {
  const res = await fetch(streamsUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`YouTube page returned ${res.status}`);

  const html = await res.text();
  const ytInitialData = extractYtInitialData(html);
  return parseInitialData(ytInitialData);
}

async function fetchContinuation(token) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/browse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20240101.00.00',
    },
    body: JSON.stringify({
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' },
      },
      continuation: token,
    }),
  });
  if (!res.ok) throw new Error(`YouTube browse API returned ${res.status}`);
  const data = await res.json();
  return parseContinuationData(data);
}

// ── Parsers ───────────────────────────────────────────────────────────────

function extractYtInitialData(html) {
  const marker = 'var ytInitialData = ';
  const start  = html.indexOf(marker);
  if (start === -1) throw new Error('ytInitialData not found — YouTube may have changed their page structure');

  const jsonStart = html.indexOf('{', start);
  let depth = 0, jsonEnd = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    if      (html[i] === '{') depth++;
    else if (html[i] === '}') { if (--depth === 0) { jsonEnd = i; break; } }
  }
  return JSON.parse(html.slice(jsonStart, jsonEnd + 1));
}

function parseInitialData(data) {
  const streams = [];
  let continuationToken = null;

  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  let contents = null;

  for (const tab of tabs) {
    const tr = tab?.tabRenderer;
    if (!tr) continue;
    // The /streams URL loads with the Live/Streams tab pre-selected
    if (tr.selected) {
      contents = tr?.content?.richGridRenderer?.contents
                 || tr?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
      break;
    }
  }

  // Fallback: find any tab that has a richGridRenderer with items
  if (!contents) {
    for (const tab of tabs) {
      const c = tab?.tabRenderer?.content?.richGridRenderer?.contents;
      if (c?.length) { contents = c; break; }
    }
  }

  if (!contents) return { streams, continuationToken };

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

  // Skip streams that are currently live (no duration = still broadcasting)
  const isLive = (vr?.badges || []).some(
    b => b?.metadataBadgeRenderer?.label === 'LIVE'
  );
  if (isLive) return null;

  const title    = vr?.title?.runs?.[0]?.text || vr?.title?.simpleText || 'Untitled';
  // YouTube returns relative strings like "Streamed 3 days ago" or "Streamed on Jan 5, 2024"
  const dateText = vr?.publishedTimeText?.simpleText || vr?.dateText?.simpleText || null;
  const thumbs   = vr?.thumbnail?.thumbnails || [];
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
