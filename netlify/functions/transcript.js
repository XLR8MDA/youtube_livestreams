/**
 * Netlify function — fetch YouTube transcript with timestamps
 *
 * GET /.netlify/functions/transcript?videoId=abc123[&channelId=UC...]
 * Response: { transcript: [{ text, offset }], source: "youtube"|"whisper-queued" }
 *   offset = seconds from video start
 *
 * When YouTube captions are unavailable the video is queued for Whisper STT
 * (processed by scheduled auto-analyze within 5–10 minutes) and a 202 is returned.
 */

const { YoutubeTranscript } = require('youtube-transcript');
const { neon }              = require('@neondatabase/serverless');

exports.handler = async (event) => {
  const { videoId, channelId } = event.queryStringParameters || {};
  if (!videoId) return respond(400, { error: 'videoId is required' });

  try {
    const raw = await YoutubeTranscript.fetchTranscript(videoId);
    const transcript = raw.map(seg => ({
      text:   seg.text,
      offset: Math.round((seg.offset ?? 0) / 1000),
    }));
    return respond(200, { transcript, source: 'youtube' });
  } catch (err) {
    const msg       = err.message || String(err);
    const noCaption = msg.includes('disabled') || msg.includes('No transcript') || msg.includes('Could not find');

    if (noCaption) {
      // Queue for Whisper STT if channelId was provided
      if (channelId && process.env.DATABASE_URL) {
        await enqueueWhisper(videoId, channelId);
      }
      return respond(202, {
        error:          'YouTube captions unavailable',
        pendingWhisper: true,
        message:        channelId
          ? 'Queued for Whisper transcription — auto-analysis will complete within 5–10 minutes.'
          : 'Captions unavailable. Pass channelId to queue for Whisper transcription.',
      });
    }

    console.error('[transcript]', msg);
    return respond(500, { error: msg });
  }
};

async function enqueueWhisper(videoId, channelId) {
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      CREATE TABLE IF NOT EXISTS dashboard_state (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const rows  = await sql`SELECT value FROM dashboard_state WHERE key = 'pending-whisper'`;
    const queue = rows.length ? (rows[0].value || []) : [];
    if (queue.find(i => i.videoId === videoId)) return;
    queue.push({ videoId, channelId, endedAt: new Date().toISOString() });
    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES ('pending-whisper', ${JSON.stringify(queue)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  } catch (err) {
    console.warn('[transcript] Failed to enqueue for Whisper:', err.message);
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
