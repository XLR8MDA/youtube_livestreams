/**
 * Netlify function — extract trade details from a chart screenshot via Groq vision
 *
 * POST /.netlify/functions/extract-trade
 *   body: { imageBase64: string, mimeType: string, pairs: [{ label, value }] }
 *   → { pair, entry, stop, exit, direction, notes }
 *
 * Chart conventions passed to the model:
 *   - Blue candles   = bullish (price going up)
 *   - Black candles  = bearish (price going down)
 *   - LEFT price scale markers:
 *       Green  line = Take Profit (exit price)
 *       Grey   line = Entry price
 *       Red    line = Stop Loss price
 */

const GROQ_API          = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!process.env.GROQ_API_KEY)  return respond(500, { error: 'GROQ_API_KEY not set' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON body' }); }

  const { imageBase64, mimeType = 'image/png', pairs = [] } = body;
  if (!imageBase64) return respond(400, { error: 'imageBase64 is required' });

  const pairsHint = pairs.length
    ? `Known pairs (try to match one of these values exactly): ${pairs.map(p => p.value).join(', ')}.`
    : 'No known pairs — extract the pair name as it appears on screen.';

  const systemPrompt = `You are a trading chart analyzer. Extract trade details from the provided chart screenshot.

Chart conventions:
- Blue candles: price moving up (bullish)
- Black candles: price moving down (bearish)
- On the LEFT price scale there are colored horizontal line markers:
    GREEN marker  = Take Profit (TP) / exit price
    GREY  marker  = Entry price
    RED   marker  = Stop Loss (SL) price
- The currency pair / instrument name is shown on the chart (e.g. "XAU/USD", "EURUSD", "NAS100")

${pairsHint}

Determine direction from the relationship between entry and take profit:
- Entry BELOW take profit → LONG
- Entry ABOVE take profit → SHORT

Return ONLY valid JSON, no markdown, no explanation:
{"pair":"XAUUSD","entry":2345.50,"stop":2330.00,"exit":2380.00,"direction":"long","notes":""}

Rules:
- pair: symbol format without slash (e.g. "XAUUSD"), match a known pair value if possible; if not, use what is on screen
- entry, stop, exit: numeric prices read from the left scale markers; null if not visible
- direction: "long" or "short"; null if cannot be determined
- notes: any extra info visible (timeframe, R:R ratio, etc.) or empty string`;

  try {
    const res = await fetch(GROQ_API, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              {
                type:      'image_url',
                image_url: { url: `data:${mimeType};base64,${imageBase64}` },
              },
              { type: 'text', text: 'Extract the trade details from this chart screenshot.' },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens:  256,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Groq API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '{}';
    const clean   = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    let extracted;
    try { extracted = JSON.parse(clean); }
    catch {
      return respond(422, { error: 'Could not parse AI response', raw: clean });
    }

    return respond(200, {
      pair:      extracted.pair      ?? null,
      entry:     extracted.entry     ?? null,
      stop:      extracted.stop      ?? null,
      exit:      extracted.exit      ?? null,
      direction: extracted.direction ?? null,
      notes:     extracted.notes     ?? '',
    });

  } catch (err) {
    console.error('[extract-trade]', err.message);
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
