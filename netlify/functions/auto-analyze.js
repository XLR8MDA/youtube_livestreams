/**
 * Netlify scheduled function — processes one pending stream analysis per run. (Relational)
 *
 * Schedule: every 10 minutes (see netlify.toml)
 * Flow:
 *   1. Pop oldest item from `pending-analysis` queue in NeonDB
 *   2. Fetch YouTube transcript
 *   3. Run Groq keyword-filtered analysis
 *   4. Upsert result to `stream_log` table
 *   5. Cache in `analysis__{videoId}` blob so the Backtest tab also benefits
 *   6. Send Telegram summary if trades were found
 *
 * Manual trigger: GET /.netlify/functions/auto-analyze
 */

const { neon }              = require('@neondatabase/serverless');
const { YoutubeTranscript } = require('youtube-transcript');

const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_CHARS_PER_CHUNK = 12_000;

const TRADE_KEYWORDS = /\b(long|short|buy|sell|entry|exit|tp|sl|stop|target|take profit|stop loss|filled|triggered|close[d]?|trade|position|order|scalp|breakout|setup|level|price|pip|lot|size|risk|reward|r:r|rr|gold|xau|eur|gbp|jpy|btc|bitcoin|nas|dow|index|futures|forex|crypto|going in|got in|i'm in|we're in|just took|just entered|just exited|just closed)\b/i;

// ── DB helpers ────────────────────────────────────────────────────────────
async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  // Ensure table exists (Phase 2)
  await sql`
    CREATE TABLE IF NOT EXISTS stream_log (
      id            BIGSERIAL PRIMARY KEY,
      video_id      TEXT NOT NULL UNIQUE,
      channel_id    TEXT NOT NULL,
      channel_name  TEXT,
      stream_title  TEXT,
      ended_at      TIMESTAMPTZ NOT NULL,
      analyzed_at   TIMESTAMPTZ,
      status        TEXT NOT NULL,
      has_traces    BOOLEAN NOT NULL DEFAULT FALSE,
      marker_count  INTEGER NOT NULL DEFAULT 0,
      markers       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

async function dbGet(sql, key, fallback = null) {
  try {
    const rows = await sql`SELECT value FROM dashboard_state WHERE key = ${key}`;
    return rows.length ? rows[0].value : fallback;
  } catch { return fallback; }
}

async function dbSet(sql, key, value) {
  await sql`
    INSERT INTO dashboard_state (key, value)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

// ── Handler ───────────────────────────────────────────────────────────────
exports.handler = async () => {
  if (!process.env.DATABASE_URL || !process.env.GROQ_API_KEY) {
    console.error('[auto-analyze] Missing DATABASE_URL or GROQ_API_KEY');
    return { statusCode: 500 };
  }

  const sql     = await getDb();
  const pending = await dbGet(sql, 'pending-analysis', []) || [];

  if (pending.length === 0) {
    console.log('[auto-analyze] No pending streams');
    return { statusCode: 200, body: JSON.stringify({ processed: 0 }) };
  }

  // Pop the oldest item (FIFO)
  const item = pending.shift();
  await dbSet(sql, 'pending-analysis', pending);

  console.log(`[auto-analyze] Processing: ${item.channelName} — ${item.videoId}`);

  const logEntry = {
    videoId:     item.videoId,
    channelId:   item.channelId,
    channelName: item.channelName,
    streamTitle: item.streamTitle,
    endedAt:     item.endedAt,
    analyzedAt:  new Date().toISOString(),
    status:      'error',
    hasTraces:   false,
    markerCount: 0,
    markers:     [],
  };

  try {
    // Fetch transcript
    let raw;
    try {
      raw = await YoutubeTranscript.fetchTranscript(item.videoId);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('disabled') || msg.includes('No transcript') || msg.includes('Could not find')) {
        logEntry.status = 'no-transcript';
      } else {
        logEntry.status = 'error';
        console.warn(`[auto-analyze] Transcript fetch failed: ${msg}`);
      }
      await writeLogEntry(sql, logEntry);
      return { statusCode: 200, body: JSON.stringify({ processed: 1, status: logEntry.status }) };
    }

    if (!raw || raw.length === 0) {
      logEntry.status = 'no-transcript';
      await writeLogEntry(sql, logEntry);
      return { statusCode: 200, body: JSON.stringify({ processed: 1, status: 'no-transcript' }) };
    }

    // Convert to timestamped lines + filter to trading content
    const allLines = raw.map(seg => {
      const secs = Math.round((seg.offset ?? 0) / 1000);
      return `[${formatTs(secs)}] ${seg.text.replace(/\s+/g, ' ').trim()}`;
    });
    const lines = allLines.filter(line => TRADE_KEYWORDS.test(line));

    let markers = [];
    if (lines.length > 0) {
      const chunks = chunkLines(lines);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(2000);
        const chunkMarkers = await analyzeChunk(chunks[i]);
        markers.push(...chunkMarkers);
      }
      markers.sort((a, b) => a.ts - b.ts);
    }

    logEntry.status      = 'analyzed';
    logEntry.hasTraces   = markers.length > 0;
    logEntry.markerCount = markers.length;
    logEntry.markers     = markers;

    // Cache in stream_analysis table so Backtest tab benefits too
    await sql`
      INSERT INTO stream_analysis (video_id, channel_id, markers, analyzed_at)
      VALUES (${item.videoId}, ${item.channelId}, ${JSON.stringify(markers)}::jsonb, NOW())
      ON CONFLICT (video_id) DO UPDATE SET
        markers = EXCLUDED.markers,
        analyzed_at = NOW()
    `;

    // Telegram summary if trades found
    if (markers.length > 0) {
      await sendTelegramSummary(item, markers).catch(err =>
        console.warn('[auto-analyze] Telegram summary failed:', err.message)
      );
    }

  } catch (err) {
    console.error('[auto-analyze] Analysis failed:', err.message);
    logEntry.status = 'error';
  }

  await writeLogEntry(sql, logEntry);
  console.log(`[auto-analyze] Done: ${logEntry.channelName} — status=${logEntry.status} markers=${logEntry.markerCount}`);
  return { statusCode: 200, body: JSON.stringify({ processed: 1, status: logEntry.status, markers: logEntry.markerCount }) };
};

// ── Stream log write ──────────────────────────────────────────────────────
async function writeLogEntry(sql, entry) {
  await sql`
    INSERT INTO stream_log (
      video_id, channel_id, channel_name, stream_title, ended_at,
      analyzed_at, status, has_traces, marker_count, markers
    ) VALUES (
      ${entry.videoId},
      ${entry.channelId},
      ${entry.channelName},
      ${entry.streamTitle},
      ${entry.endedAt},
      ${entry.analyzedAt},
      ${entry.status},
      ${entry.hasTraces},
      ${entry.markerCount},
      ${JSON.stringify(entry.markers)}::jsonb
    )
    ON CONFLICT (video_id) DO UPDATE SET
      analyzed_at = EXCLUDED.analyzed_at,
      status = EXCLUDED.status,
      has_traces = EXCLUDED.has_traces,
      marker_count = EXCLUDED.marker_count,
      markers = EXCLUDED.markers
  `;
}

// ── Groq call ─────────────────────────────────────────────────────────────
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

// ── Telegram summary ──────────────────────────────────────────────────────
async function sendTelegramSummary(item, markers) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const videoUrl   = `https://youtube.com/watch?v=${item.videoId}`;
  const entries    = markers.filter(m => m.type === 'entry').length;
  const exits      = markers.filter(m => m.type === 'exit').length;
  const topMarkers = markers.slice(0, 5).map(m =>
    `• [${formatTs(m.ts)}] ${escMd(m.label)}`
  ).join('\n');

  const text = [
    `📊 *Stream ended — trade summary*`,
    `👤 ${escMd(item.channelName)}`,
    item.streamTitle ? `📺 ${escMd(item.streamTitle)}` : null,
    ``,
    `🟢 Entries: ${entries}  🔴 Exits: ${exits}`,
    ``,
    topMarkers,
    markers.length > 5 ? `_\\.\\.\\. and ${markers.length - 5} more_` : null,
    ``,
    `[▶ Watch Stream](${videoUrl})`,
  ].filter(l => l !== null).join('\n');

  const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'MarkdownV2' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
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

function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
