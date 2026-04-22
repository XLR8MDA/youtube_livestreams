/**
 * Netlify scheduled function — checks all saved channels every 2 minutes,
 * sends a Telegram notification for any channel that just went live.
 *
 * Schedule is set in netlify.toml:
 *   [functions."live-checker"]
 *     schedule = "*/2 * * * *"
 *
 * Required env vars:
 *   YOUTUBE_API_KEY      — same key used by youtube.js proxy
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   URL                  — your Netlify site URL (auto-set by Netlify)
 */

const { getStore } = require('@netlify/blobs');

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const LIVE_STATE_KEY = 'live-state'; // blob key: { [channelId]: { isLive, videoId } }

exports.handler = async () => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('[live-checker] YOUTUBE_API_KEY not set');
    return { statusCode: 500 };
  }

  const store = getStore('dashboard');

  // Load saved channels
  const channels = await store.get('channels', { type: 'json' }).catch(() => []);
  if (!Array.isArray(channels) || channels.length === 0) {
    console.log('[live-checker] No channels saved');
    return { statusCode: 200 };
  }

  // Load last known live state
  const prevState = await store.get(LIVE_STATE_KEY, { type: 'json' }).catch(() => ({})) || {};

  const newState = { ...prevState };
  const newlyLive = [];

  // Step 1 — batch-check channels that had a known videoId (cheap: 1 quota unit)
  const channelsWithVideo = channels.filter(c => prevState[c.channelId]?.videoId);
  if (channelsWithVideo.length > 0) {
    const ids = channelsWithVideo.map(c => prevState[c.channelId].videoId).join(',');
    const url = new URL(`${YT_API_BASE}/videos`);
    url.searchParams.set('part', 'snippet,liveStreamingDetails');
    url.searchParams.set('id', ids);
    url.searchParams.set('key', apiKey);

    try {
      const res = await fetch(url.toString());
      const data = await res.json();
      const liveMap = new Map((data.items || []).map(item => [
        item.id,
        item.snippet?.liveBroadcastContent === 'live',
      ]));

      for (const ch of channelsWithVideo) {
        const videoId = prevState[ch.channelId].videoId;
        const stillLive = liveMap.get(videoId) ?? false;
        newState[ch.channelId] = { isLive: stillLive, videoId: stillLive ? videoId : null };
      }
    } catch (err) {
      console.warn('[live-checker] batch video check failed:', err.message);
    }
  }

  // Step 2 — search for channels with no known videoId (100 quota units each, but necessary)
  const channelsWithoutVideo = channels.filter(c => !newState[c.channelId]?.videoId);
  for (const ch of channelsWithoutVideo) {
    const url = new URL(`${YT_API_BASE}/search`);
    url.searchParams.set('part', 'id');
    url.searchParams.set('channelId', ch.channelId);
    url.searchParams.set('eventType', 'live');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '1');
    url.searchParams.set('key', apiKey);

    try {
      const res = await fetch(url.toString());
      const data = await res.json();
      const videoId = data?.items?.[0]?.id?.videoId || null;
      newState[ch.channelId] = { isLive: !!videoId, videoId };
    } catch (err) {
      console.warn(`[live-checker] search failed for ${ch.name}:`, err.message);
    }
  }

  // Step 3 — find channels that just went live (not live before, live now)
  for (const ch of channels) {
    const wasLive = prevState[ch.channelId]?.isLive ?? false;
    const isNowLive = newState[ch.channelId]?.isLive ?? false;
    if (!wasLive && isNowLive) {
      newlyLive.push(ch);
    }
  }

  // Step 4 — send Telegram notifications
  const dashboardUrl = process.env.URL || '';
  for (const ch of newlyLive) {
    try {
      await sendTelegramNotification(ch.name || ch.handle || ch.channelId, dashboardUrl);
      console.log(`[live-checker] Notified: ${ch.name} is live`);
    } catch (err) {
      console.warn(`[live-checker] Notify failed for ${ch.name}:`, err.message);
    }
  }

  // Step 5 — save updated live state
  await store.set(LIVE_STATE_KEY, JSON.stringify(newState));

  console.log(`[live-checker] Done — ${channels.length} channels checked, ${newlyLive.length} newly live`);
  return { statusCode: 200 };
};

async function sendTelegramNotification(channelName, dashboardUrl) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const text = `🔴 *${escMd(channelName)}* is LIVE\\!\n\n[Open Dashboard](${dashboardUrl})`;
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false,
      }),
    }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
}

function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
