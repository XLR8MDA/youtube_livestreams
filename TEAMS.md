# Teams — Claude + Codex Coordination

This file is the shared workspace between Claude Code and Codex.
Update your section when you start/finish a task. Leave notes for each other here.

---

## Ownership Split

| Area | Owner |
|---|---|
| All `netlify/functions/` | Claude |
| `netlify.toml` | Claude |
| `package.json` | Claude |
| `app.js` (existing live dashboard logic) | Claude |
| `index.html` — tab nav + backtest panel HTML | **Codex** |
| `style.css` — backtest + journal styles | **Codex** |
| `backtest.js` — new file, all backtest frontend logic | **Codex** |

---

## Claude — Status

### Netlify Blobs (channels persistence)
- [x] `netlify/functions/channels.js` — GET/POST channels array
- [x] `package.json` — added `@netlify/blobs`
- [x] `app.js` — `loadState()` async, remote-first; `saveChannels()` posts to remote

### Telegram Notifications
- [x] `netlify/functions/notify.js` — POST endpoint, sends Telegram message
- [x] `netlify/functions/live-checker.js` — scheduled every 2 min, checks all channels, notifies on new live
- [x] `netlify.toml` — registered `live-checker` schedule

### Backtest Backend
- [x] `netlify/functions/past-streams.js` — fetches past completed livestreams per channel (10 per page)
- [x] `netlify/functions/journal.js` — full CRUD for trade journal entries (GET/POST/PATCH/DELETE)

### Pending / Notes for Codex
- `app.js` exports the `channels` array as a global — Codex can read `window.channels` or the global `channels` var directly in `backtest.js`
- Tab switching: add a `data-tab` attribute on tab buttons; Claude will wire up the switcher in `app.js` once Codex defines the HTML structure
- Do NOT modify `app.js` state management (channels array, polling, players)

---

## Codex — Status

### Backtest Tab UI
- [ ] Add tab nav to `index.html` (`#tab-live`, `#tab-backtest`)
- [ ] Add `#backtest-panel` div to `index.html` (hidden by default)
- [ ] Inside panel: channel selector, stream list, video player area, journal sidebar
- [ ] Add `<script src="backtest.js">` to `index.html`
- [ ] CSS in `style.css` — backtest panel layout, stream list cards, journal form, results table

### `backtest.js` — Frontend Logic
- [ ] `initBacktest()` — populate channel selector from global `channels` array
- [ ] `loadPastStreams(channelId, pageToken)` — GET `/.netlify/functions/past-streams?channelId=...`
- [ ] Render stream list with thumbnail, title, date
- [ ] `playStream(videoId, streamId, streamTitle)` — load into YT player
- [ ] Trade entry form: Direction (Long/Short), Entry, Exit, Result (Win/Loss/BE), R:R (auto-calc), Notes
- [ ] `submitTrade(formData)` — POST `/.netlify/functions/journal`
- [ ] `loadJournalEntries(channelId, streamId)` — GET `/.netlify/functions/journal?channelId=...&streamId=...`
- [ ] Render journal entries list; delete button per entry
- [ ] Analytics view: aggregate entries by channel → win rate, avg R:R, total trades

---

## API Reference (for Codex)

### GET `/.netlify/functions/past-streams`
```
Query: channelId=UC...[&pageToken=...]
Response: {
  streams: [{ videoId, title, publishedAt, thumbnail }],
  nextPageToken: string | null
}
```

### GET `/.netlify/functions/journal`
```
Query: channelId=UC...&streamId=videoId
Response: [{ id, direction, entry, exit, result, rr, notes, videoTimestamp, createdAt }]
```

### POST `/.netlify/functions/journal`
```json
{
  "channelId": "UC...",
  "streamId": "videoId",
  "streamTitle": "Stream title",
  "entry": {
    "direction": "long",
    "entry": 1.2345,
    "exit": 1.2360,
    "result": "win",
    "rr": 2.0,
    "notes": "clean OB entry",
    "videoTimestamp": 3720
  }
}
Response: { "ok": true, "id": "abc123" }
```

### DELETE `/.netlify/functions/journal`
```
Query: channelId=UC...&streamId=videoId&entryId=abc123
Response: { "ok": true }
```

### PATCH `/.netlify/functions/journal`
```json
{
  "channelId": "UC...",
  "streamId": "videoId",
  "entryId": "abc123",
  "updates": { "notes": "updated note", "result": "loss" }
}
Response: { "ok": true }
```

---

## Notes / Decisions Log

- **2026-04-22 (Claude):** Using Netlify Blobs for all persistence (channels + journal). No external DB needed.
- **2026-04-22 (Claude):** `live-checker` runs every 2 min server-side — works even when dashboard is closed.
- **2026-04-22 (Claude):** Journal blob key format: `journal__{channelId}__{streamId}`. Index key: `journal-index__{channelId}`.
- **Codex:** When the backtest panel HTML is ready, ping Claude here so tab-switching logic can be wired into `app.js`.
