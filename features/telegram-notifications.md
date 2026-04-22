# Feature: Telegram Live Notifications

## Setup (one-time, manual)
- [ ] Create a Telegram bot via BotFather — get bot token
- [ ] Get your Telegram chat ID (send a message to the bot, call getUpdates API)
- [ ] Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as env vars in Netlify dashboard

## Backend — Notify Function
- [ ] Create `netlify/functions/notify.js` — accepts POST with `{ channelName, dashboardUrl }`, calls Telegram sendMessage API
- [ ] Format message: channel name, "is LIVE", clickable dashboard URL

## Backend — Scheduled Checker (server-side cron, works 24/7)
- [ ] Create `netlify/functions/live-checker.js` — scheduled Netlify function
- [ ] On each run: load saved channels from Netlify Blobs
- [ ] Call YouTube API (via existing proxy logic) to check live status of all channels
- [ ] Load last known live state from Netlify Blobs (`live-state` key)
- [ ] Compare current vs last known state — find newly live channels
- [ ] For each newly live channel: call `notify` function (or inline the Telegram call)
- [ ] Save updated live state back to Netlify Blobs
- [ ] Register the cron schedule in `netlify.toml` (e.g. every 2 minutes)

## Frontend (optional enhancement)
- [ ] Add a "Notifications" toggle in the settings modal
- [ ] When toggled on, browser also sends a notify call when it detects a channel going live (backup to cron)
