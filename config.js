/**
 * Trading Stream Dashboard — Configuration
 *
 * SETUP INSTRUCTIONS:
 * 1. Get a free YouTube Data API v3 key:
 *    - Go to https://console.cloud.google.com/
 *    - Create a project → Enable "YouTube Data API v3"
 *    - Create credentials → API key
 *    - Restrict the key: HTTP referrers → localhost:8080/*
 *
 * 2. Add your channels below (channelId or @handle — both work).
 *    To find a channel ID: go to the channel page → view source → search "channelId"
 *    Or use the @handle directly (e.g. "@ICmarkets").
 *
 * 3. Serve files over HTTP (required — file:// won't work):
 *    Open a terminal in this folder and run:
 *      python -m http.server 8080
 *    Then open: http://localhost:8080
 */

window.TRADING_CONFIG = {

  // ── Your YouTube Data API v3 key ──────────────────────────────────────────
  API_KEY: '', // Enter your key via the ⚙ button in the app — it saves to localStorage

  // ── Default channels to monitor ───────────────────────────────────────────
  // Add as many as you like. You can also add/remove them from the UI.
  // Use channelId (starts with UC...) OR handle (@SomeName) — not both.
  DEFAULT_CHANNELS: [
    // Examples — replace or add your actual trading channels:
    // { name: 'ICT',                handle: '@InnerCircleTrader', channelId: null },
    // { name: 'Smart Money Forex',  handle: '@SmartMoneyForex',   channelId: null },
    // { name: 'My Channel',         channelId: 'UCxxxxxxxxxxxxxxxx', handle: null },
  ],

  // ── Polling intervals ─────────────────────────────────────────────────────
  POLL_INTERVAL_FAST_MS: 30_000,     // videos.list check — every 30 seconds
  POLL_INTERVAL_SLOW_MS: 120_000,    // search.list refresh — every 2 minutes

  // ── Default grid columns ─────────────────────────────────────────────────
  DEFAULT_GRID_COLS: 2,
};
