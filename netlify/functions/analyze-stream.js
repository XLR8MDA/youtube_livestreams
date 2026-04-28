/**
 * Netlify function — fetch transcript, run Grok analysis, return trade markers
 *
 * GET /.netlify/functions/analyze-stream?videoId=abc123&channelId=UC...
 * Response: { cached: bool, markers: [{ ts, label, type }] }
 *   ts   = seconds from video start
 *   type = "entry" | "exit" | "discussion"
 *
 * POST /.netlify/functions/analyze-stream  { videoId, channelId }
 *   Force re-analysis (ignores cache)
 */

const { neon }            = require('@neondatabase/serverless');
const { YoutubeTranscript } = require('youtube-transcript');

const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_CHARS_PER_CHUNK = 180_000; // safe headroom under grok-3-mini's context

// ── DB helpers ────────────────────────────────────────────────────────────
async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS dashboard_state (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  return sql;
}

async function dbGet(sql, key) {
  const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${key}`;
  return rows.length ? rows[0].value : null;
}

async function dbSet(sql, key, value) {
  await sql`
    INSERT INTO dashboard_state (key, value)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

// ── Handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });
  if (!process.env.GROQ_API_KEY)  return respond(500, { error: 'GROQ_API_KEY not set' });

  const isForce = event.httpMethod === 'POST';
  const params  = isForce
    ? JSON.parse(event.body || '{}')
    : (event.queryStringParameters || {});

  const { videoId, channelId } = params;
  if (!videoId || !channelId) return respond(400, { error: 'videoId and channelId are required' });

  const cacheKey = `analysis__${videoId}`;

  try {
    const sql = await getDb();

    // Return cached result unless forced re-analysis
    if (!isForce) {
      const cached = await dbGet(sql, cacheKey);
      if (cached) return respond(200, { cached: true, markers: cached.markers || [] });
    }

    // Fetch transcript
    let raw;
    try {
      raw = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('disabled') || msg.includes('No transcript') || msg.includes('Could not find')) {
        return respond(404, { error: 'Transcript not available for this video' });
      }
      throw err;
    }

    if (!raw || raw.length === 0) {
      return respond(404, { error: 'Transcript is empty' });
    }

    // Convert to compact timestamped lines: "[HH:MM:SS] text"
    const lines = raw.map(seg => {
      const secs = Math.round((seg.offset ?? 0) / 1000);
      return `[${formatTs(secs)}] ${seg.text.replace(/\s+/g, ' ').trim()}`;
    });

    // Split into chunks if transcript is very long (8h+ streams)
    const chunks = chunkLines(lines);

    // Run Grok on each chunk, merge all markers
    const allMarkers = [];
    for (const chunk of chunks) {
      const chunkMarkers = await analyzeChunk(chunk);
      allMarkers.push(...chunkMarkers);
    }

    // Sort by timestamp
    allMarkers.sort((a, b) => a.ts - b.ts);

    // Cache result
    await dbSet(sql, cacheKey, { videoId, channelId, analyzedAt: new Date().toISOString(), markers: allMarkers });

    return respond(200, { cached: false, markers: allMarkers });
  } catch (err) {
    console.error('[analyze-stream]', err.message);
    return respond(500, { error: err.message });
  }
};

// ── Grok call ─────────────────────────────────────────────────────────────
async function analyzeChunk(lines) {
  const transcriptText = lines.join('\n');

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
        { role: 'user',   content: transcriptText },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Grok API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data    = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '[]';

  // Parse the JSON response — strip any accidental markdown fences
  const clean = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  let markers;
  try {
    markers = JSON.parse(clean);
  } catch {
    console.warn('[analyze-stream] Grok returned non-JSON:', clean.slice(0, 300));
    markers = [];
  }

  // Validate and sanitise each marker
  return markers
    .filter(m => m && typeof m.ts === 'number' && typeof m.label === 'string')
    .map(m => ({
      ts:    Math.round(m.ts),
      label: String(m.label).slice(0, 120),
      type:  ['entry', 'exit', 'discussion'].includes(m.type) ? m.type : 'discussion',
    }));
}

// ── Helpers ───────────────────────────────────────────────────────────────
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
  let current = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > MAX_CHARS_PER_CHUNK && current.length > 0) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
