/**
 * Netlify function — send a Telegram notification when a channel goes live
 *
 * POST /.netlify/functions/notify
 * Body: { channelName: string, dashboardUrl: string }
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN  — from BotFather
 *   TELEGRAM_CHAT_ID    — your personal chat ID
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return respond(500, { error: 'Telegram env vars not configured' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { channelName, dashboardUrl } = body;
  if (!channelName) return respond(400, { error: 'channelName is required' });

  const text = `🔴 *${escMd(channelName)}* is LIVE\\!\n\n[Open Dashboard](${dashboardUrl || ''})`;

  try {
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
    if (!data.ok) return respond(502, { error: data.description });
    return respond(200, { ok: true });
  } catch (err) {
    return respond(502, { error: err.message });
  }
};

// Escape special chars for Telegram MarkdownV2
function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
