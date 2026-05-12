/**
 * Netlify function — process voice transcript for life log via Groq
 *
 * POST /.netlify/functions/life-voice
 *   body: { transcript: string }
 *   → { activity: string, category: string }
 */

const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are a personal life logging assistant. The user will dictate what they did or are doing during the current hour. Your job is to:

1. Write a clean, concise activity description — max 1-2 sentences, well-written, no filler words. Remove "um", "uh", repetitions. Keep it factual and clear.
2. Pick the single best category from this exact list:
   - trading   (trading sessions, forex, chart analysis, market review)
   - work      (meetings, emails, coding, client work, admin tasks)
   - exercise  (gym, running, walking, sport, yoga, workout)
   - learning  (studying, reading, courses, research, watching tutorials)
   - rest      (sleeping, napping, relaxing, meditation, break)
   - social    (friends, family, calls, socialising, events)
   - food      (eating, cooking, meals, groceries)
   - other     (anything that doesn't fit the above)

Return ONLY valid JSON with this exact shape, no markdown, no explanation:
{"activity":"...","category":"..."}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!process.env.GROQ_API_KEY)  return respond(500, { error: 'GROQ_API_KEY not set' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON' }); }

  const { transcript } = body;
  if (!transcript || !transcript.trim()) return respond(400, { error: 'transcript is required' });

  try {
    const res = await fetch(GROQ_API, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: transcript.trim() },
        ],
        temperature: 0.2,
        max_tokens:  200,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`);
    }

    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '{}';
    const clean   = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return respond(422, { error: 'Could not parse AI response', raw: clean }); }

    const VALID_CATS = ['trading','work','exercise','learning','rest','social','food','other'];
    return respond(200, {
      activity: String(parsed.activity || transcript).trim(),
      category: VALID_CATS.includes(parsed.category) ? parsed.category : 'other',
    });

  } catch (err) {
    console.error('[life-voice]', err.message);
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
