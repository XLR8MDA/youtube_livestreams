# MultiPlay - Project Context
> Single source of truth for architecture, ownership, and API contracts.
> Update this file when new functions, features, or decisions are added.

---

## What This App Does
A live trading dashboard that:
- Shows multiple YouTube live streams simultaneously in a grid
- Monitors channels and notifies (Telegram + browser) when they go live
- Has a **Backtest tab** to browse past streams, log trades, and review journal analytics
- Tags each channel with a currency pair (XAU/USD, EUR/USD, etc.)
- Can analyze ended streams in the backend using YouTube captions plus a Groq LLM to extract trade markers for logs and cache

---

## Tech Stack
| Layer | Tech |
|---|---|
| Frontend | Vanilla JS (`app.js`, `backtest.js`), HTML, CSS |
| Backend | Netlify Functions (Node.js serverless) |
| Database | NeonDB (PostgreSQL) via `@neondatabase/serverless` |
| Video | YouTube IFrame API + YouTube Data API v3 |
| LLM | Groq API - `llama-3.3-70b-versatile` |
| Transcript | `youtube-transcript` npm package |
| Notifications | Telegram Bot API + browser Notification API |
| Hosting | Netlify |

---

## File Ownership

### Claude owns
| File | Responsibility |
|---|---|
| `app.js` | All state management - channels, customPairs, polling, audio, notifications |
| `netlify/functions/channels.js` | Channel list persistence (NeonDB) |
| `netlify/functions/custom-pairs.js` | Global currency pair list (NeonDB) |
| `netlify/functions/youtube.js` | Server-side YouTube API proxy |
| `netlify/functions/live-checker.js` | Scheduled live detection + Telegram notifications |
| `netlify/functions/notify.js` | Telegram message sender |
| `netlify/functions/past-streams.js` | Fetch past livestreams per channel |
| `netlify/functions/journal.js` | Trade journal CRUD |
| `netlify/functions/transcript.js` | Fetch YouTube transcript from available YouTube captions |
| `netlify/functions/analyze-stream.js` | Groq trade marker analysis + NeonDB cache (on-demand) |
| `netlify/functions/auto-analyze.js` | Scheduled analysis for `pending-analysis` queue, writes to `stream_log` |
| `netlify/functions/extract-trade.js` | POST image -> Groq vision -> extracted trade fields |
| `netlify/functions/stream-log.js` | GET stream log grouped by date, filterable by days/channelId |
| `netlify/functions/reviewed-streams.js` | Reviewed stream IDs per channel, plus manual reviewed state |
| `netlify/functions/course-playlist.js` | Course playlist fetcher |
| `netlify/functions/save-to-drive.js` | Save screenshots to Google Drive |
| `netlify/functions/drive-auth.js` | Google Drive auth helpers |
| `netlify.toml` | Function schedules and config |
| `package.json` | Dependencies |

### Codex owns
| File | Responsibility |
|---|---|
| `index.html` | All HTML - tab nav, live grid, backtest panel, modals |
| `base.css` | Shared app foundation styles |
| `style.css` | Live tab styles and any remaining shared legacy styles |
| `backtest.css` | Backtest tab styles |
| `stats.css` | Stats tab styles |
| `course.css` | Course tab styles |
| `backtest.js` | Backtest tab logic - stream list, player, journal form, screenshots, reviewed state |

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
| `stream_id` | `TEXT` | YouTube video ID |
| `stream_title` | `TEXT` | |
| `pair` | `TEXT` | |
| `direction` | `TEXT` | `long` / `short` |
| `result` | `TEXT` | `win` / `loss` / `be` |
| `entry_price` | `DOUBLE` | |
| `exit_price` | `DOUBLE` | |
| `stop_price` | `DOUBLE` | |
| `rr` | `DOUBLE` | |
| `notes` | `TEXT` | |
| `video_timestamp` | `INTEGER` | Seconds |
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
| `status` | `TEXT` | `analyzed`, `error`, `no-transcript`, etc. |
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

#### `reviewed_streams`
| Column | Type | Notes |
|---|---|---|
| `video_id` | `TEXT` | PRIMARY KEY (composite) |
| `channel_id` | `TEXT` | PRIMARY KEY (composite) |
| `reviewed_at` | `TIMESTAMPTZ` | |

#### `live_state`
| Column | Type | Notes |
|---|---|---|
| `channel_id` | `TEXT` | PRIMARY KEY |
| `is_live` | `BOOLEAN` | |
| `last_video_id` | `TEXT` | |
| `stream_title` | `TEXT` | |
| `last_notified_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | |

### Legacy / KV Store
| Key pattern | Contents |
|---|---|
| `pending-analysis` | `[{ videoId, channelId, channelName, streamTitle, endedAt }]` |
| `live-checker-last-run` | ISO timestamp |
| `journal-index__{channelId}` | Legacy index for backward compatibility |

---

## API Reference

### `channels`
```text
GET  /.netlify/functions/channels
POST /.netlify/functions/channels
```

### `custom-pairs`
```text
GET    /.netlify/functions/custom-pairs
POST   /.netlify/functions/custom-pairs
DELETE /.netlify/functions/custom-pairs?value=EURGBP
```

### `past-streams`
```text
GET /.netlify/functions/past-streams?channelId=UC...[&pageToken=...]
-> { streams: [{ videoId, title, publishedAt, thumbnail }], nextPageToken }
```

### `journal`
```text
GET    /.netlify/functions/journal?channelId=UC...&streamId=videoId
POST   /.netlify/functions/journal
PATCH  /.netlify/functions/journal
DELETE /.netlify/functions/journal?channelId=UC...&streamId=...&entryId=...
```

### `transcript`
```text
GET /.netlify/functions/transcript?videoId=abc123
-> { transcript: [{ text, offset }], source: "youtube" }
-> 404 if captions are unavailable
```

### `analyze-stream`
```text
GET  /.netlify/functions/analyze-stream?videoId=abc123&channelId=UC...
POST /.netlify/functions/analyze-stream
```

### `reviewed-streams`
```text
GET    /.netlify/functions/reviewed-streams?channelId=UC...
POST   /.netlify/functions/reviewed-streams
DELETE /.netlify/functions/reviewed-streams?videoId=...&channelId=...
```

### `course-playlist`
```text
GET /.netlify/functions/course-playlist?playlistId=...
```

### `save-to-drive`
```text
POST /.netlify/functions/save-to-drive
```

---

## Environment Variables
| Var | Used by | Notes |
|---|---|---|
| `YOUTUBE_API_KEY` | `youtube.js`, `live-checker.js`, `past-streams.js` | YouTube Data API v3 |
| `TELEGRAM_BOT_TOKEN` | `notify.js`, `live-checker.js` | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | `notify.js`, `live-checker.js` | Target chat/channel ID |
| `DATABASE_URL` | Netlify functions | NeonDB PostgreSQL connection string |
| `GROQ_API_KEY` | `analyze-stream.js`, `auto-analyze.js`, `extract-trade.js` | Groq API key |
| `URL` | `live-checker.js` | Auto-set by Netlify for notification links |

---

## Key Architecture Decisions
- **Single NeonDB KV + relational mix** - relational tables for stable entities, `dashboard_state` for lightweight queue/state blobs.
- **`app.js` stays Claude-owned** - avoid channel polling and global app state changes unless explicitly asked.
- **Caption-only transcript flow** - transcript-dependent features rely on YouTube captions only; if captions stay unavailable after retries, streams are marked `no-transcript`.
- **Groq for LLM tasks** - marker extraction and screenshot parsing use Groq models.
- **Feature CSS split** - `base.css` is shared foundation; feature styles live in `style.css`, `backtest.css`, `stats.css`, and `course.css`.

---

## Sprints
- [Sprint 1](sprints/sprint-1.md) - Foundation
- [Sprint 2](sprints/sprint-2.md) - Pairs, transcript analysis, notifications
- [Sprint 3](sprints/sprint-3.md) - Stream trade log
