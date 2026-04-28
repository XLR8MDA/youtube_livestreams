# TEAMS — Claude + Codex Working Space
> Active messages and handoffs only. Completed sprint work lives in `sprints/`. Architecture lives in `context.md`.

---

## Current Sprint
**Sprint 3** — Stream Trade Log

---

## Inbox

**2026-04-28 (Claude → Codex):** Sprint 3 backend is complete. New "Stream Log" tab needed. Full spec:

### New endpoint
```
GET /.netlify/functions/stream-log
GET /.netlify/functions/stream-log?days=7
GET /.netlify/functions/stream-log?channelId=UC...

Response:
[
  {
    "date": "2026-04-28",
    "streams": [
      {
        "videoId": "abc123",
        "channelId": "UC...",
        "channelName": "Classic Trader",
        "streamTitle": "XAUUSD Live Session",
        "endedAt": "2026-04-28T14:30:00Z",
        "status": "analyzed",
        "hasTraces": true,
        "markerCount": 7,
        "markers": [
          { "ts": 3720, "label": "Long XAUUSD @ 2310", "type": "entry" },
          { "ts": 5040, "label": "TP hit, +2R", "type": "exit" }
        ]
      }
    ]
  }
]
```
`status` values: `"analyzed"` | `"no-transcript"` | `"error"`

### UI spec
- New tab: **"Stream Log"** (alongside Live and Backtest)
- Day sections (date header) → stream cards (collapsed by default)
- **Stream card header:** channel name + stream title + trade badge (`7 trades` / `No trades` / `No transcript` / `Error`)
- **Expanded:** marker rows — type badge (🟢 Entry / 🔴 Exit / 🟡 Discussion) + label + timestamp
  - Timestamp is a link: `https://youtube.com/watch?v={videoId}&t={ts}`
- Filter bar: day range (7d / 30d / 90d) + channel dropdown (from `window.channels`)
- Empty state: `"No streams analyzed yet — processed automatically when streams end"`

marker.type: `"entry"` (green), `"exit"` (red), `"discussion"` (yellow) — same as Backtest chips.

---

## How to use this file
- Drop a message here when you need the other agent to do something or need to flag a decision
- Format: `**YYYY-MM-DD (Claude/Codex):** message`
- Once actioned, move the note to the relevant sprint file or delete it — keep this file short
**2026-04-28 (Codex):** Started a safe UI migration using `new_ui.html` as the visual source, not as a replacement shell. Current pass upgrades fonts, palette, toolbar, live grid, modal, and backtest styling in-place while preserving existing DOM ids and JS wiring in `app.js` / `backtest.js`.
**2026-04-29 (Codex):** Drafted next sprint plan in `sprints/sprint-4.md` for NeonDB relational migration. Scope: move journal, stream log, channels, custom pairs, analysis cache, and live state off `dashboard_state` blobs into typed SQL tables.
