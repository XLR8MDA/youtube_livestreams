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
| `netlify/functions/transcript.js` | Fetch YouTube transcript; queues for Whisper if captions unavailable |
| `netlify/functions/_whisper.js` | Shared Whisper STT module (not a standalone function — prefixed _) |
| `netlify/functions/analyze-stream.js` | Groq trade marker analysis + NeonDB cache (on-demand, from Backtest tab) |
| `netlify/functions/auto-analyze.js` | Scheduled (*/10 min) — processes `pending-analysis` queue, writes to `stream-log` |
| `netlify/functions/extract-trade.js` | POST — receives base64 chart screenshot, calls Groq vision, returns extracted trade fields |
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

### Relational Tables

#### `channels`
| Column | Type | Notes |
|---|---|---|
| `channel_id` | `TEXT` | PRIMARY KEY |
| `name` | `TEXT` | NOT NULL |
| `handle` | `TEXT` | |
| `pair` | `TEXT` | Active currency pair |
| `is_active` | `BOOLEAN` | Default TRUE |
| `manual_video_id` | `BOOLEAN` | Skip auto-check if TRUE |
| `created_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | |

#### `custom_pairs`
| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY |
| `label` | `TEXT` | NOT NULL |
| `value` | `TEXT` | UNIQUE |
| `created_at` | `TIMESTAMPTZ` | |

#### `journal_entries`
| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` | PRIMARY KEY |
| `channel_id` | `TEXT` | |
| `stream_id` | `TEXT` | videoId |
| `stream_title` | `TEXT` | |
| `pair` | `TEXT` | |
| `direction` | `TEXT` | long/short |
| `result` | `TEXT` | win/loss/be |
| `entry_price` | `DOUBLE` | |
| `exit_price` | `DOUBLE` | |
| `stop_price` | `DOUBLE` | |
| `rr` | `DOUBLE` | |
| `notes` | `TEXT` | |
| `video_timestamp`| `INTEGER` | Seconds |
| `created_at` | `TIMESTAMPTZ` | |

#### `stream_log`
| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY |
| `video_id` | `TEXT` | UNIQUE |
| `channel_id` | `TEXT` | |
| `channel_name` | `TEXT` | |
| `stream_title` | `TEXT` | |
| `ended_at` | `TIMESTAMPTZ` | |
| `analyzed_at` | `TIMESTAMPTZ` | |
| `status` | `TEXT` | analyzed/error/etc |
| `has_traces` | `BOOLEAN` | |
| `marker_count` | `INTEGER` | |
| `markers` | `JSONB` | Array of markers |

#### `stream_analysis`
| Column | Type | Notes |
|---|---|---|
| `video_id` | `TEXT` | PRIMARY KEY |
| `channel_id` | `TEXT` | |
| `markers` | `JSONB` | Array of markers |
| `analyzed_at` | `TIMESTAMPTZ` | |

#### `live_state`
| Column | Type | Notes |
|---|---|---|
| `channel_id` | `TEXT` | PRIMARY KEY |
| `is_live` | `BOOLEAN` | |
| `last_video_id` | `TEXT` | |
| `stream_title` | `TEXT` | |
| `last_notified_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | |

### Legacy Store (Flexible paylaods)
| Key pattern | Contents |
|---|---|
| `'pending-analysis'` | `[{ videoId, channelId, channelName, streamTitle, endedAt }]` |
| `'live-checker-last-run'` | `ISOString` |
| `'journal-index__{channelId}'` | Legacy index for backward compatibility |

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

### `extract-trade`
```
POST /.netlify/functions/extract-trade
     body: { imageBase64: string, mimeType: string, pairs: [{ label, value }] }
     → { pair, entry, stop, exit, direction, notes }
     Conventions: blue candles=up, black=down; left scale: green=TP, grey=entry, red=SL
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
| `GROQ_API_KEY` | `analyze-stream.js`, `auto-analyze.js` | Groq LLM — `llama-3.3-70b-versatile` |
| `GROQ_API_KEY_1` | `_whisper.js` | Groq Whisper pool key 1 (also fallback if no 1–4 set) |
| `GROQ_API_KEY_2` | `_whisper.js` | Groq Whisper pool key 2 |
| `GROQ_API_KEY_3` | `_whisper.js` | Groq Whisper pool key 3 |
| `GROQ_API_KEY_4` | `_whisper.js` | Groq Whisper pool key 4 |
| `URL` | `live-checker.js` | Auto-set by Netlify — dashboard URL included in notifications |

---

## Key Architecture Decisions
- **Single NeonDB table** (`dashboard_state` key/value JSONB) — avoids schema migrations for new data types
- **`app.js` is Claude's** — Codex must not touch state management, polling, or player logic
- **Global custom pairs** — shared list, each channel picks its active pair independently
- **Groq for LLM** — OpenAI-compatible API, model `llama-3.3-70b-versatile`, 131k context window
- **Transcript chunking** — splits at 180k chars to stay within Groq context limits; markers merged and sorted
- **Whisper STT fallback** — when YouTube captions unavailable, `auto-analyze.js` falls back to `_whisper.js`: downloads lowest-bitrate audio-only stream via `@distube/ytdl-core`, chunks into ≤20MB pieces, transcribes via Groq `whisper-large-v3-turbo`, rotates across `GROQ_API_KEY_1..4` per chunk with 429 backoff. `pending-whisper` queue in NeonDB; processed by scheduled `auto-analyze` after `pending-analysis` is clear
- **`pending-whisper` queue** — same `dashboard_state` KV store; populated by `analyze-stream.js` (on-demand) and `auto-analyze.js` (after MAX_RETRIES caption failure); consumed by `processWhisperItem()` in `auto-analyze.js`
- **Notification permission** — requested 3s after page load (not immediately, avoids instant browser rejection)
- **live-checker state** — persisted in NeonDB so cold-start functions can detect false→true live transitions

---

## Sprints
- [Sprint 1](sprints/sprint-1.md) — Foundation (channels, journal, backtest tab)
- [Sprint 2](sprints/sprint-2.md) — Pairs, transcript analysis, notifications
- [Sprint 3](sprints/sprint-3.md) — Stream trade log (auto-analyze on stream end)
