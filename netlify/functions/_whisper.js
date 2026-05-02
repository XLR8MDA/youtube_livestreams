'use strict';
/**
 * Shared Whisper STT utility — NOT a standalone Netlify function (prefixed _)
 *
 * Exported: fetchWhisperTranscript(videoId) → [{ text, offset }]
 *   offset = seconds from video start  (same shape as youtube-transcript)
 *
 * Strategy:
 *   1. Get lowest-bitrate audio-only stream via @distube/ytdl-core
 *   2. Download full audio into memory buffer
 *   3. Slice into ≤20 MB chunks (free-tier Groq limit is 25 MB)
 *   4. Transcribe each chunk with Groq Whisper (verbose_json for segment timestamps)
 *   5. Rotate across GROQ_API_KEY_1 … GROQ_API_KEY_4 per chunk; backoff on 429
 *   6. Offset each segment's timestamp by the chunk's byte-position in the stream
 */

const ytdl = require('@distube/ytdl-core');
const { Blob } = require('buffer');

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL    = 'whisper-large-v3-turbo';
const CHUNK_BYTES      = 20 * 1024 * 1024; // 20 MB — safely under the 25 MB free-tier cap
const INTER_CHUNK_MS   = 1500;             // polite pause between API calls

// ── Key pool ──────────────────────────────────────────────────────────────
function getKeyPool() {
  const keys = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ].filter(Boolean);
  // Graceful fallback: reuse the LLM key if no dedicated Whisper keys are set
  if (!keys.length && process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY);
  return keys;
}

// ── Main export ───────────────────────────────────────────────────────────
async function fetchWhisperTranscript(videoId) {
  const keys = getKeyPool();
  if (!keys.length) {
    throw new Error('No Groq API keys for Whisper — set GROQ_API_KEY_1 … GROQ_API_KEY_4');
  }

  // 1. Get audio format info from YouTube
  const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);

  const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
  if (!audioFormats.length) throw new Error('No audio-only format available for this video');

  // Lowest bitrate = smallest download → less memory, fewer chunks
  audioFormats.sort((a, b) => (a.audioBitrate || 999) - (b.audioBitrate || 999));
  const format = audioFormats[0];

  const bitrateBps = (format.audioBitrate || 64) * 1000 / 8; // bytes/sec estimate
  const rawMime    = (format.mimeType || 'audio/webm').split(';')[0]; // strip codecs suffix
  const ext        = rawMime.includes('webm') ? 'webm'
                   : rawMime.includes('mp4')  ? 'mp4'
                   : rawMime.includes('ogg')  ? 'ogg'
                   : 'webm';

  // 2. Download full audio into an in-memory buffer
  console.log(`[whisper] Downloading ${videoId} — format: ${rawMime}, ~${format.audioBitrate}kbps`);
  const audioBuffer = await downloadToBuffer(videoId, format);
  console.log(`[whisper] Downloaded ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  // 3. Slice into ≤CHUNK_BYTES pieces
  const chunks = [];
  for (let i = 0; i < audioBuffer.length; i += CHUNK_BYTES) {
    chunks.push(audioBuffer.slice(i, Math.min(i + CHUNK_BYTES, audioBuffer.length)));
  }
  console.log(`[whisper] Transcribing ${chunks.length} chunk(s)`);

  // 4. Transcribe with key rotation + 429 protection
  const cooling     = new Set(); // keys currently rate-limited
  let keyIdx        = 0;
  const allSegments = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(INTER_CHUNK_MS);

    const byteOffset = i * CHUNK_BYTES;
    const timeOffset = Math.round(byteOffset / bitrateBps); // approx seconds into video

    const key = pickKey(keys, cooling, keyIdx);
    if (!key) throw new Error('All Groq Whisper API keys are rate-limited');

    try {
      const segments = await transcribeChunk(chunks[i], ext, rawMime, key, timeOffset);
      allSegments.push(...segments);
      keyIdx = (keyIdx + 1) % keys.length; // advance for next chunk
      console.log(`[whisper] Chunk ${i + 1}/${chunks.length}: ${segments.length} segments`);
    } catch (err) {
      if (err.isRateLimit) {
        console.warn(`[whisper] Key …${key.slice(-4)} rate-limited — rotating`);
        cooling.add(key);
        i--; // retry the same chunk with the next key
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }

  return allSegments; // [{ text, offset }]
}

// ── Helpers ───────────────────────────────────────────────────────────────
function pickKey(keys, cooling, preferred) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(preferred + i) % keys.length];
    if (!cooling.has(k)) return k;
  }
  return null; // all cooling
}

function downloadToBuffer(videoId, format) {
  return new Promise((resolve, reject) => {
    const parts  = [];
    const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { format });
    stream.on('data',  chunk => parts.push(chunk));
    stream.on('end',   ()    => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

async function transcribeChunk(buffer, ext, mimeType, apiKey, timeOffset) {
  const blob = new Blob([buffer], { type: mimeType });
  const form = new FormData();
  form.append('file',                      blob, `audio.${ext}`);
  form.append('model',                     WHISPER_MODEL);
  form.append('response_format',           'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  // Prompt steers spelling of trading-specific terms (Whisper tip from Groq docs)
  form.append('prompt',
    'Trading livestream. Instruments: XAU/USD gold, EUR/USD, GBP/USD, NAS100 Nasdaq, Bitcoin BTC. ' +
    'Terms: long, short, buy, sell, entry, stop loss, take profit, TP, SL, risk reward, RR.'
  );

  const res = await fetch(GROQ_WHISPER_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body:    form,
  });

  if (res.status === 429) {
    const err       = new Error('Rate limited');
    err.isRateLimit = true;
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq Whisper ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data     = await res.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];

  return segments
    .map(seg => ({
      text:   (seg.text || '').trim(),
      offset: Math.round((seg.start || 0) + timeOffset),
    }))
    .filter(s => s.text.length > 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchWhisperTranscript };
