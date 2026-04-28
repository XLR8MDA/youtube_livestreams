# Sprint 3 — Stream Trade Log
**Status:** In Progress  
**Date:** 2026-04-28

---

## Goal
When any watched channel ends a live stream, automatically transcribe it, run Groq trade analysis, and display the results in a new "Stream Log" page — organised day-by-day, stream-by-stream, with clickable trade timestamps.

---

## Architecture

```
live-checker (*/2 min)
  └─ detects live→ended transition
  └─ queues to NeonDB `pending-analysis`

auto-analyze (*/10 min)
  └─ pops one item from queue
  └─ fetches YouTube transcript
  └─ runs Groq keyword-filtered analysis
  └─ writes to NeonDB `stream-log`
  └─ caches in `analysis__{videoId}` (Backtest tab benefits too)
  └─ sends Telegram summary if trades found

stream-log (GET endpoint)
  └─ reads `stream-log` from NeonDB
  └─ filters by days / channelId
  └─ groups by date, returns newest first

Stream Log Tab (frontend)
  └─ day sections → stream cards → marker chips
  └─ chip click → opens YouTube at that timestamp
```

---

## Delivered

### Claude
| File | What it does |
|---|---|
| `live-checker.js` | Added: detect `true→false` transitions, queue ended streams to `pending-analysis` |
| `netlify/functions/auto-analyze.js` | New scheduled function (*/10 min) — pops queue, transcribes, analyzes, stores in `stream-log` + `analysis__{videoId}` + Telegram summary |
| `netlify/functions/stream-log.js` | GET endpoint — returns stream log grouped by date, filterable by `days` and `channelId` |
| `netlify.toml` | Registered `auto-analyze` on `*/10 * * * *` |

### Codex
| File | What it does |
|---|---|
| `index.html` | New "Stream Log" tab |
| `style.css` | Stream log page styles |
| `stream-log-ui.js` (or in backtest.js) | Fetch + render day/stream/marker hierarchy |

---

## NeonDB Keys Added
| Key | Contents |
|---|---|
| `pending-analysis` | `[{ videoId, channelId, channelName, streamTitle, endedAt }]` — FIFO queue |
| `stream-log` | `[{ videoId, channelId, channelName, streamTitle, endedAt, analyzedAt, status, hasTraces, markerCount, markers }]` — max 90 entries, newest first |

---

## Stream Log Entry Schema
```js
{
  videoId:     "abc123",
  channelId:   "UC...",
  channelName: "Classic Trader",
  streamTitle: "XAUUSD Live Session",
  endedAt:     "2026-04-28T14:30:00Z",   // when stream went offline
  analyzedAt:  "2026-04-28T14:40:00Z",   // when auto-analyze ran
  status:      "analyzed",               // "analyzed" | "no-transcript" | "error" | "pending"
  hasTraces:   true,
  markerCount: 7,
  markers: [
    { ts: 3720, label: "Long XAUUSD @ 2310", type: "entry" },
    { ts: 5040, label: "TP hit, +2R", type: "exit" }
  ]
}
```

## API
```
GET /.netlify/functions/stream-log               → last 30 days, all channels
GET /.netlify/functions/stream-log?days=7        → last 7 days
GET /.netlify/functions/stream-log?channelId=UC… → filter by channel
GET /.netlify/functions/stream-log/pending       → debug: pending queue

Response: [{ date: "2026-04-28", streams: [entry, ...] }]
```

## Telegram Summary (on stream end, if trades found)
```
📊 Stream ended — trade summary
👤 Classic Trader
📺 XAUUSD Live Session

🟢 Entries: 3  🔴 Exits: 4

• [1:02:00] Long XAUUSD @ 2310
• [1:24:00] TP hit, closed +2R
• ...

▶ Watch Stream
```
