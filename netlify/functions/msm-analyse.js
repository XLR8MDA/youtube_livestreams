/**
 * Netlify function — MSM Strategy Analysis of a YouTube trading stream
 *
 * GET /.netlify/functions/msm-analyse?videoId=abc123
 *   → { cached, videoId, marketContext, trades[], topLessons[] }
 *
 * POST /.netlify/functions/msm-analyse { videoId }
 *   Force re-analysis (ignores cache)
 */

const { neon }            = require('@neondatabase/serverless');
const { YoutubeTranscript } = require('youtube-transcript');

const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

/* ─── MSM Strategy Knowledge ─────────────────────────────────────────────── */
const MSM_SYSTEM_PROMPT = `You are an expert trading analyst specialising in the MSM (Momentum Sniper Method) strategy.

## MSM STRATEGY RULES (your reference framework)

### 5 Core Steps
1. MARKET STRUCTURE — Identify if the market is bullish (HH+HL) or bearish (LH+LL). Never trade against the trend without a confirmed CHOCH.
2. HTF POI (Higher Timeframe Point of Interest) — Mark zones on 1H/2H/4H/Daily: Order Blocks, FVGs, Support/Resistance, Fibonacci 0.5 level, Liquidity zones. This is where a reversal or continuation is expected.
3. CHOCH (Change of Character) — At the HTF POI, look for a structure shift on lower timeframe (15m preferred). A bullish CHOCH = previous high breaks with candle close. A bearish CHOCH = previous low breaks with candle close. Avoid 1m (too many fakes); prefer 5m/15m close confirmation.
4. PULLBACK — After CHOCH, do NOT enter immediately. Wait for the market to retrace to Fibonacci (0.5 level preferred), Order Block, or FVG. The pullback should be SLOW (small candles, gradual) — not impulsive. Slow = likely continuation. Aggressive = potential reversal.
5. CONFIRMATION CANDLE — At the pullback zone, wait for a strong candle in the trade direction (strong bullish for buys, strong bearish for sells). This is the entry trigger.

### Entry & Risk Rules
- SL: Above pullback high (sell) / below pullback low (buy). Give extra space — never tight SL.
- TP: Target liquidity zones — previous highs/lows, equal highs/lows, internal liquidity. TP1 nearest, TP2 next, TP3 major.
- Preferred timeframes: 15m for structure/entry, 5m for confirmation.
- Partial TP + move SL to BE on runner is standard execution.

### Checklist (SELL)
marketStructure | htfPoi | choch | pullback | slowPullback | confirmationCandle | slPlacement | liquidityTarget

### Checklist (BUY) — same fields, opposite direction

### Psychology Pillars
- Slow selling ≠ reversal. It is a pullback.
- Aggressive selling = potential reversal.
- Judge trade quality by original reasoning, NOT by current P&L.
- A trade can be correct and still go deep into drawdown.
- Liquidity often gets swept before reversal.
- Structure > liquidity alone.
- Perfect setups do not exist — practice builds confidence.

---

## YOUR JOB

You will receive a transcript (possibly in Hindi or Hindi-English mix) from a live trading stream.

Analyse it against the MSM strategy above and return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:

{
  "marketContext": "2-3 sentence summary of the overall market context discussed (in English)",
  "trades": [
    {
      "pair": "USDJPY",
      "direction": "long",
      "session": "london",
      "timeframe": "M15",
      "htfBias": "Bullish — structure shifted after previous lower high was broken",
      "htfPoi": "15m + 30m Order Block at 145.20 area",
      "choch": "Bullish CHOCH on 15m — broke previous high with strong candle close",
      "pullbackType": "Slow selling pullback — weak bearish candles, gradual retracement",
      "pullbackZone": "Fibonacci 0.5 / Order Block",
      "confirmationCandle": "Strong bullish candle at OB rejecting lower prices",
      "entryReasoning": "Multi-reason: OB zone + unswept liquidity above + bullish CHOCH + slow pullback",
      "slPlacement": "Below the recent pullback low, with extra space",
      "tpTargets": "TP1: nearby liquidity (partial), TP2: previous high area (runner)",
      "drawdown": "Near full SL (95%) before market rejected and moved up",
      "drawdownResponse": "Held — structure and OB still valid, no aggressive selling seen",
      "partialTp": true,
      "result": "win",
      "msmChecklist": {
        "marketStructure": true,
        "htfPoi": true,
        "choch": true,
        "pullback": true,
        "slowPullback": true,
        "confirmationCandle": true,
        "slPlacement": true,
        "liquidityTarget": true
      },
      "psychologyNotes": "Held through 95% SL drawdown because original reasoning remained valid. Kept repeating: 'trade logic is still valid'.",
      "executionInsights": [
        "Did not enter immediately after CHOCH — waited for pullback",
        "Used two positions: one for partial TP, one as runner",
        "Moved SL to BE after partial profit secured"
      ],
      "summary": "3-5 sentence trade summary"
    }
  ],
  "topLessons": [
    "Slow selling during pullback does not mean reversal — it means market is resting",
    "Judge trade quality by the original setup reasoning, not temporary drawdown",
    "Liquidity above was unswept — that alone justified a long bias"
  ],
  "msmConformity": "high"
}

Rules:
- Translate everything from Hindi to English.
- If multiple trades were discussed, include each as a separate object in the "trades" array.
- direction must be exactly "long" or "short".
- result must be exactly "win", "loss", or "be" (breakeven). If unclear, use "be".
- session must be exactly "london", "ny", "asia", or "" if not mentioned.
- timeframe must be exactly "M5", "M15", "M30", "H1", "H4", "D1" or "" if not mentioned.
- msmConformity must be "high", "medium", or "low".
- partialTp must be true or false.
- All msmChecklist fields must be true or false.
- If a field has no information, use an empty string "".
- Keep all text concise and in English.
- Return ONLY the JSON object. No markdown fences, no extra text.`;

/* ─── DB setup ────────────────────────────────────────────────────────────── */
async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS msm_analysis (
      video_id    TEXT PRIMARY KEY,
      result      JSONB NOT NULL,
      analysed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return sql;
}

/* ─── Handler ─────────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });
  if (!process.env.GROQ_API_KEY)  return respond(500, { error: 'GROQ_API_KEY not set' });

  const isForce = event.httpMethod === 'POST';
  const params  = isForce
    ? JSON.parse(event.body || '{}')
    : (event.queryStringParameters || {});

  const { videoId } = params;
  if (!videoId) return respond(400, { error: 'videoId is required' });

  try {
    const sql = await getDb();

    // Return cached result unless force re-analyse
    if (!isForce) {
      const rows = await sql`SELECT result FROM msm_analysis WHERE video_id = ${videoId}`;
      if (rows.length) return respond(200, { cached: true, videoId, ...rows[0].result });
    }

    // Fetch transcript
    let raw;
    try {
      raw = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (err) {
      const msg = err.message || String(err);
      const noCaption = msg.includes('disabled') || msg.includes('No transcript') || msg.includes('Could not find');
      if (noCaption) return respond(404, { error: 'YouTube captions unavailable for this video' });
      throw err;
    }

    if (!raw || raw.length === 0) return respond(404, { error: 'Transcript is empty' });

    // Smart filtering: keep all trading/analysis-relevant lines
    // For Hindi streams, include more generic terms since keywords appear transliterated
    const MSM_KEYWORDS = /\b(long|short|buy|sell|entry|exit|tp|sl|stop|target|structure|bias|choch|pullback|ob|fvg|fibonacci|fib|liquidity|sweep|breakout|setup|level|price|momentum|reversal|continuation|support|resistance|timeframe|scalp|trade|position|order|risk|reward|gold|xau|eur|gbp|jpy|usd|btc|nas|dow|high|low|break|candle|close|open|market|zone)\b/i;

    const allLines = raw.map(seg => seg.text.replace(/\s+/g, ' ').trim()).filter(Boolean);

    // For Hindi transcripts, the keyword filter may miss too much — take every 3rd line to sample full context
    // while also including all keyword-matching lines
    const keywordLines  = allLines.filter(line => MSM_KEYWORDS.test(line));
    const sampledLines  = allLines.filter((_, i) => i % 3 === 0);
    const combined      = [...new Set([...keywordLines, ...sampledLines])];

    // Cap at ~7000 chars to stay within Groq TPM limits (system prompt is ~2500 tokens)
    const transcriptText = combined.join(' ').slice(0, 7_000);

    // Call Groq
    const groqRes = await fetch(GROQ_API, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages: [
          { role: 'system', content: MSM_SYSTEM_PROMPT },
          { role: 'user',   content: `Analyse this trading stream transcript and return the MSM analysis JSON:\n\n${transcriptText}` },
        ],
        temperature: 0.15,
        max_tokens:  4096,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      throw new Error(`Groq ${groqRes.status}: ${err.slice(0, 200)}`);
    }

    const groqData = await groqRes.json();
    const content  = groqData?.choices?.[0]?.message?.content?.trim() || '{}';
    const clean    = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return respond(422, { error: 'Could not parse Groq response', raw: clean.slice(0, 400) }); }

    // Sanitise
    const result = sanitiseResult(parsed);

    // Cache
    await sql`
      INSERT INTO msm_analysis (video_id, result, analysed_at)
      VALUES (${videoId}, ${JSON.stringify(result)}::jsonb, NOW())
      ON CONFLICT (video_id) DO UPDATE SET result = EXCLUDED.result, analysed_at = NOW()
    `;

    return respond(200, { cached: false, videoId, ...result });

  } catch (err) {
    console.error('[msm-analyse]', err.message);
    return respond(500, { error: err.message });
  }
};

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function sanitiseResult(p) {
  const VALID_DIR  = ['long', 'short'];
  const VALID_RES  = ['win', 'loss', 'be'];
  const VALID_SESS = ['london', 'ny', 'asia', ''];
  const VALID_TF   = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1', ''];
  const VALID_CONF = ['high', 'medium', 'low'];
  const CHECKLIST_KEYS = ['marketStructure', 'htfPoi', 'choch', 'pullback', 'slowPullback', 'confirmationCandle', 'slPlacement', 'liquidityTarget'];

  const trades = Array.isArray(p.trades) ? p.trades.map(t => ({
    pair:               String(t.pair               || '').toUpperCase(),
    direction:          VALID_DIR.includes(t.direction)  ? t.direction  : 'long',
    session:            VALID_SESS.includes(t.session)   ? t.session    : '',
    timeframe:          VALID_TF.includes(t.timeframe)   ? t.timeframe  : '',
    htfBias:            String(t.htfBias            || ''),
    htfPoi:             String(t.htfPoi             || ''),
    choch:              String(t.choch              || ''),
    pullbackType:       String(t.pullbackType       || ''),
    pullbackZone:       String(t.pullbackZone       || ''),
    confirmationCandle: String(t.confirmationCandle || ''),
    entryReasoning:     String(t.entryReasoning     || ''),
    slPlacement:        String(t.slPlacement        || ''),
    tpTargets:          String(t.tpTargets          || ''),
    drawdown:           String(t.drawdown           || ''),
    drawdownResponse:   String(t.drawdownResponse   || ''),
    partialTp:          t.partialTp === true,
    result:             VALID_RES.includes(t.result)     ? t.result     : 'be',
    msmChecklist:       Object.fromEntries(
      CHECKLIST_KEYS.map(k => [k, t.msmChecklist?.[k] === true])
    ),
    psychologyNotes:    String(t.psychologyNotes    || ''),
    executionInsights:  Array.isArray(t.executionInsights) ? t.executionInsights.map(String) : [],
    summary:            String(t.summary            || ''),
  })) : [];

  return {
    marketContext:  String(p.marketContext  || ''),
    trades,
    topLessons:     Array.isArray(p.topLessons) ? p.topLessons.map(String) : [],
    msmConformity:  VALID_CONF.includes(p.msmConformity) ? p.msmConformity : 'medium',
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
