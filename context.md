# MultiPlay — Project Context
> Single source of truth for architecture, ownership, and API contracts.  
> Update this file when new functions, features, or decisions are added.

---

## What This App Does
A live trading dashboard that:
- Shows multiple YouTube live streams simultaneously in a grid
- Monitors channels and notifies (Telegram + browser) when they go live
- Has a **Backtest tab** — browse past streams, log trades against them, review journal analytics
- Tags each channel with a currency pair (XAU/USD, EUR/USD, etc.)
- Can **analyze a past stream** — fetches transcript, runs Groq LLM, marks timestamps where trades were discussed

---

## Tech Stack
| Layer | Tech |
|---|---|
| Frontend | Vanilla JS (`app.js`, `backtest.js`), HTML, CSS |
| Backend | Netlify Functions (Node.js serverless) |
| Database | NeonDB (PostgreSQL) via `@neondatabase/serverless` |
| Video | YouTube IFrame API + YouTube Data API v3 |
| LLM | Groq API — `llama-3.3-70b-versatile` |
| Transcript | `youtube-transcript` npm package |
| Notifications | Telegram Bot API + browser Notification API |
| Hosting | Netlify |

---

## File Ownership

### Claude owns
| File | Responsibility |
|---|---|
| `app.js` | All state management — channels, customPairs, polling, audio, notifications |
| `netlify/functions/channels.js` | Channel list persistence (NeonDB) |
| `netlify/functions/custom-pairs.js` | Global currency pair list (NeonDB) |
| `netlify/functions/youtube.js` | Server-side YouTube API proxy |
| `netlify/functions/live-checker.js` | Scheduled live detection + Telegram notifications |
| `netlify/functions/notify.js` | Telegram message sender |
| `netlify/functions/past-streams.js` | Fetch past livestreams per channel |
| `netlify/functions/journal.js` | Trade journal CRUD |
| `netlify/functions/transcript.js` | Fetch YouTube transcript |
| `netlify/functions/analyze-stream.js` | Groq trade marker analysis + NeonDB cache (on-demand, from Backtest tab) |
| `netlify/functions/auto-analyze.js` | Scheduled (*/10 min) — processes `pending-analysis` queue, writes to `stream-log` |
| `netlify/functions/stream-log.js` | GET stream log grouped by date, filterable by days/channelId |
| `netlify.toml` | Function schedules and config |
| `package.json` | Dependencies |

### Codex owns
| File | Responsibility |
|---|---|
| `index.html` | All HTML — tab nav, live grid, backtest panel, modals |
| `style.css` | All styles |
| `backtest.js` | Backtest tab logic — stream list, player, journal form, analytics, analyze markers |

---

## NeonDB Schema
All data lives in a single `dashboard_state` table:
```sql
CREATE TABLE IF NOT EXISTS dashboard_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

| Key pattern | Contents |
|---|---|
| `'channels'` | `[{ channelId, name, handle, videoId, isLive, viewers, pair }]` |
| `'custom-pairs'` | `[{ label, value }]` — global user-defined pairs |
| `'live-state'` | `{ [channelId]: { isLive, videoId, streamTitle } }` — used by live-checker |
| `'journal__{channelId}__{streamId}'` | `[{ id, direction, entry, exit, result, rr, notes, videoTimestamp, createdAt }]` |
| `'journal-index__{channelId}'` | `[{ streamId, streamTitle, entryCount, date }]` |
| `'analysis__{videoId}'` | `{ videoId, channelId, analyzedAt, markers: [{ ts, label, type }] }` |
| `'pending-analysis'` | `[{ videoId, channelId, channelName, streamTitle, endedAt }]` — auto-analyze queue |
| `'stream-log'` | `[{ videoId, channelId, channelName, streamTitle, endedAt, analyzedAt, status, hasTraces, markerCount, markers }]` — max 90 entries |

---

## API Reference

### `channels`
```
GET  /.netlify/functions/channels          → [channel, ...]
POST /.netlify/functions/channels          body: [channel, ...] → { ok: true }
```

### `custom-pairs`
```
GET    /.netlify/functions/custom-pairs                    → [{ label, value }, ...]
POST   /.netlify/functions/custom-pairs   body: { label, value } → { ok, pairs }
DELETE /.netlify/functions/custom-pairs?value=EURGBP       → { ok, pairs }
```

### `past-streams`
```
GET /.netlify/functions/past-streams?channelId=UC...[&pageToken=...]
→ { streams: [{ videoId, title, publishedAt, thumbnail }], nextPageToken }
```

### `journal`
```
GET    /.netlify/functions/journal?channelId=UC...&streamId=videoId
       → [{ id, direction, entry, exit, result, rr, notes, videoTimestamp, createdAt }]

POST   /.netlify/functions/journal
       body: { channelId, streamId, streamTitle, entry: { direction, entry, exit, result, rr, notes, videoTimestamp } }
       → { ok: true, id }

PATCH  /.netlify/functions/journal
       body: { channelId, streamId, entryId, updates: {...} }
       → { ok: true }

DELETE /.netlify/functions/journal?channelId=UC...&streamId=...&entryId=...
       → { ok: true }
```

### `transcript`
```
GET /.netlify/functions/transcript?videoId=abc123
→ { transcript: [{ text, offset }] }   offset = seconds from start
→ 404 { error: "Transcript not available..." } if captions disabled
```

### `analyze-stream`
```
GET  /.netlify/functions/analyze-stream?videoId=abc123&channelId=UC...
     → { cached: bool, markers: [{ ts, label, type }] }
     type: "entry" | "exit" | "discussion"

POST /.netlify/functions/analyze-stream
     body: { videoId, channelId }   ← forces re-analysis, ignores cache
     → { cached: false, markers: [...] }
```

### `live-checker` (scheduled + manual)
```
GET /.netlify/functions/live-checker   ← manual trigger for debugging
→ { checked: N, notified: N }
```

---

## Environment Variables
| Var | Used by | Notes |
|---|---|---|
| `YOUTUBE_API_KEY` | `youtube.js`, `live-checker.js`, `past-streams.js` | YouTube Data API v3 |
| `TELEGRAM_BOT_TOKEN` | `notify.js`, `live-checker.js` | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | `notify.js`, `live-checker.js` | Target chat/channel ID |
| `DATABASE_URL` | All Netlify functions | NeonDB PostgreSQL connection string |
| `GROQ_API_KEY` | `analyze-stream.js` | Groq inference API — `llama-3.3-70b-versatile` (12k TPM free tier, chunked) |
| `URL` | `live-checker.js` | Auto-set by Netlify — dashboard URL included in notifications |

---

## Key Architecture Decisions
- **Single NeonDB table** (`dashboard_state` key/value JSONB) — avoids schema migrations for new data types
- **`app.js` is Claude's** — Codex must not touch state management, polling, or player logic
- **Global custom pairs** — shared list, each channel picks its active pair independently
- **Groq for LLM** — OpenAI-compatible API, model `llama-3.3-70b-versatile`, 131k context window
- **Transcript chunking** — splits at 180k chars to stay within Groq context limits; markers merged and sorted
- **Notification permission** — requested 3s after page load (not immediately, avoids instant browser rejection)
- **live-checker state** — persisted in NeonDB so cold-start functions can detect false→true live transitions

---

## Sprints
- [Sprint 1](sprints/sprint-1.md) — Foundation (channels, journal, backtest tab)
- [Sprint 2](sprints/sprint-2.md) — Pairs, transcript analysis, notifications
- [Sprint 3](sprints/sprint-3.md) — Stream trade log (auto-analyze on stream end)
