/**
 * Netlify function - fetch YouTube transcript with timestamps
 *
 * GET /.netlify/functions/transcript?videoId=abc123
 * Response: { transcript: [{ text, offset }], source: "youtube" }
 *   offset = seconds from video start
 */

const { YoutubeTranscript } = require('youtube-transcript');

exports.handler = async (event) => {
  const { videoId } = event.queryStringParameters || {};
  if (!videoId) return respond(400, { error: 'videoId is required' });

  try {
    const raw = await YoutubeTranscript.fetchTranscript(videoId);
    const transcript = raw.map(seg => ({
      text: seg.text,
      offset: Math.round((seg.offset ?? 0) / 1000),
    }));
    return respond(200, { transcript, source: 'youtube' });
  } catch (err) {
    const msg = err.message || String(err);
    const noCaption = msg.includes('disabled') || msg.includes('No transcript') || msg.includes('Could not find');

    if (noCaption) {
      return respond(404, { error: 'YouTube captions unavailable' });
    }

    console.error('[transcript]', msg);
    return respond(500, { error: msg });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
