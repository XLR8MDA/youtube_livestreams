/**
 * Netlify function — fetch transcript, run Groq analysis, return trade markers (Relational)
 *
 * GET  /.netlify/functions/analyze-stream?videoId=abc123&channelId=UC...
 *   → { cached: bool, markers: [{ ts, label, type }] }
 *   ts   = seconds from video start
 *   type = "entry" | "exit" | "discussion"
 *
 * POST /.netlify/functions/analyze-stream  { videoId, channelId }
 *   Force re-analysis (ignores cache)
 */

const { neon }              = require('@neondatabase/serverless');
const { YoutubeTranscript } = require('youtube-transcript');

const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_CHARS_PER_CHUNK = 12_000;

const TRADE_KEYWORDS = /\b(long|short|buy|sell|entry|exit|tp|sl|stop|target|take profit|stop loss|filled|triggered|close[d]?|trade|position|order|scalp|breakout|setup|level|price|pip|lot|size|risk|reward|r:r|rr|gold|xau|eur|gbp|jpy|btc|bitcoin|nas|dow|index|futures|forex|crypto|going in|got in|i'm in|we're in|just took|just entered|just exited|just closed)\b/i;

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  // Ensure table exists (Phase 4)
  await sql`
    CREATE TABLE IF NOT EXISTS stream_analysis (
      video_id      TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      markers       JSONB NOT NULL,
      analyzed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });
  if (!process.env.GROQ_API_KEY) return respond(500, { error: 'GROQ_API_KEY not set' });

  const isForce = event.httpMethod === 'POST';
  const params  = isForce
    ? JSON.parse(event.body || '{}')
    : (event.queryStringParameters || {});

  const { videoId, channelId } = params;
  if (!videoId || !channelId) return respond(400, { error: 'videoId and channelId are required' });

  try {
    const sql = await getDb();

    // Return cached result unless forced re-analysis
    if (!isForce) {
      const rows = await sql`SELECT markers FROM stream_analysis WHERE video_id = ${videoId}`;
      if (rows.length) return respond(200, { cached: true, markers: rows[0].markers || [] });
    }

    // Fetch transcript — YouTube captions first, Whisper queue as fallback
    let raw;
    try {
      raw = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (err) {
      const msg       = err.message || String(err);
      const noCaption = msg.includes('disabled') || msg.includes('No transcript') || msg.includes('Could not find');
      if (noCaption) {
        // Queue for Whisper STT — auto-analyze (runs every 5 min) will handle it
        await enqueueWhisper(sql, videoId, channelId);
        return respond(200, {
          cached:         false,
          markers:        [],
          pendingWhisper: true,
          message:        'YouTube captions unavailable — queued for Whisper transcription. Auto-analysis will complete within 5–10 minutes.',
        });
      }
      throw err;
    }

    if (!raw || raw.length === 0) {
      return respond(404, { error: 'Transcript is empty' });
    }

    const allLines = raw.map(seg => {
      const secs = Math.round((seg.offset ?? 0) / 1000);
      return `[${formatTs(secs)}] ${seg.text.replace(/\s+/g, ' ').trim()}`;
    });
    const lines = allLines.filter(line => TRADE_KEYWORDS.test(line));

    let allMarkers = [];
    if (lines.length > 0) {
      const chunks = chunkLines(lines);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(2000);
        const chunkMarkers = await analyzeChunk(chunks[i]);
        allMarkers.push(...chunkMarkers);
      }
      allMarkers.sort((a, b) => a.ts - b.ts);
    }

    await sql`
      INSERT INTO stream_analysis (video_id, channel_id, markers, analyzed_at)
      VALUES (${videoId}, ${channelId}, ${JSON.stringify(allMarkers)}::jsonb, NOW())
      ON CONFLICT (video_id) DO UPDATE SET
        markers = EXCLUDED.markers,
        analyzed_at = NOW()
    `;
    
    return respond(200, { cached: false, markers: allMarkers });

  } catch (err) {
    console.error('[analyze-stream]', err.message);
    return respond(500, { error: err.message });
  }
};

async function analyzeChunk(lines) {
  const systemPrompt = `You are a trading analysis assistant. You will receive a timestamped transcript from a trading live stream.
Identify every moment where the streamer:
- Announces a trade entry (buy/sell, long/short, taking a trade)
- Announces a trade exit (take profit, stop loss, close, out of trade)
- Discusses a live setup or trade idea with a specific price level or instrument
Do NOT include generic market commentary, news discussion, or greetings.
Return ONLY a valid JSON array in this exact format — no extra text, no markdown, no explanation:
[{"ts":3720,"label":"Long XAUUSD @ 2310","type":"entry"},{"ts":5040,"label":"TP hit, closed +2R","type":"exit"}]
ts = seconds from video start (integer). type must be exactly "entry", "exit", or "discussion".
If nothing relevant is found, return an empty array: []`;

  const res = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: lines.join('\n') },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data    = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '[]';
  const clean   = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

  let markers;
  try { markers = JSON.parse(clean); }
  catch { markers = []; }

  return markers
    .filter(m => m && typeof m.ts === 'number' && typeof m.label === 'string')
    .map(m => ({
      ts:    Math.round(m.ts),
      label: String(m.label).slice(0, 120),
      type:  ['entry', 'exit', 'discussion'].includes(m.type) ? m.type : 'discussion',
    }));
}

function formatTs(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function chunkLines(lines) {
  const chunks = [];
  let current = [], len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > MAX_CHARS_PER_CHUNK && current.length > 0) {
      chunks.push(current); current = []; len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Push videoId into the pending-whisper queue (processed by scheduled auto-analyze)
async function enqueueWhisper(sql, videoId, channelId) {
  try {
    // Ensure dashboard_state table exists (auto-analyze normally owns this)
    await sql`
      CREATE TABLE IF NOT EXISTS dashboard_state (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const rows  = await sql`SELECT value FROM dashboard_state WHERE key = 'pending-whisper'`;
    const queue = rows.length ? (rows[0].value || []) : [];
    if (queue.find(i => i.videoId === videoId)) return; // already queued
    queue.push({ videoId, channelId, endedAt: new Date().toISOString() });
    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES ('pending-whisper', ${JSON.stringify(queue)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    console.log(`[analyze-stream] Whisper queued: ${videoId}`);
  } catch (err) {
    console.warn('[analyze-stream] Failed to enqueue for Whisper:', err.message);
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
