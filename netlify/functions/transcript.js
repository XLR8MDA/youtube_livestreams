/**
 * Netlify function — fetch YouTube transcript with timestamps
 *
 * GET /.netlify/functions/transcript?videoId=abc123
 * Response: { transcript: [{ text, offset }] }  (offset = seconds from start)
 * Error:    { error: "..." }
 */

const { YoutubeTranscript } = require('youtube-transcript');

exports.handler = async (event) => {
  const videoId = event.queryStringParameters?.videoId;
  if (!videoId) return respond(400, { error: 'videoId is required' });

  try {
    const raw = await YoutubeTranscript.fetchTranscript(videoId);
    // offset comes in milliseconds from the library — convert to seconds
    const transcript = raw.map(seg => ({
      text:   seg.text,
      offset: Math.round((seg.offset ?? 0) / 1000),
    }));
    return respond(200, { transcript });
  } catch (err) {
    const msg = err.message || String(err);
    // Distinguish "no captions" from genuine errors
    if (msg.includes('disabled') || msg.includes('No transcript') || msg.includes('Could not find')) {
      return respond(404, { error: 'Transcript not available for this video' });
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
