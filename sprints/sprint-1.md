# Sprint 1 — Foundation
**Status:** Complete  
**Date:** 2026-04-22

---

## Goals
Stand up the live dashboard with persistent channel storage, Telegram notifications, and a backtest/journal tab.

## Delivered

### Claude
| File | What it does |
|---|---|
| `netlify/functions/channels.js` | GET/POST channels array — NeonDB `dashboard_state` table, key `'channels'` |
| `netlify/functions/notify.js` | POST endpoint — sends a Telegram message via Bot API |
| `netlify/functions/live-checker.js` | Scheduled every 2 min — checks all channels, notifies on new live (state stored in `dashboard_state` key `'live-state'`) |
| `netlify/functions/past-streams.js` | GET past completed livestreams per channel (10/page, paginated) |
| `netlify/functions/journal.js` | Full CRUD for trade journal entries — NeonDB keys `journal__{channelId}__{streamId}` |
| `netlify/functions/youtube.js` | Server-side proxy for YouTube Data API (keeps key out of browser) |
| `netlify.toml` | Registered `live-checker` on `*/2 * * * *` schedule |
| `app.js` | `loadState()` async remote-first, `saveChannels()` posts to remote, full live dashboard polling |

### Codex
| File | What it does |
|---|---|
| `index.html` | Tab nav (`#tab-live`, `#tab-backtest`), backtest panel HTML, journal sidebar |
| `style.css` | Backtest panel layout, stream list cards, journal form, results table |
| `backtest.js` | `initBacktest()`, `loadPastStreams()`, `playStream()`, trade entry form, `submitTrade()`, `loadJournalEntries()`, analytics view |

## Key Decisions
- **NeonDB (PostgreSQL)** for all persistence — started with Netlify Blobs, migrated to NeonDB for reliability
- Journal key format: `journal__{channelId}__{streamId}`, index key: `journal-index__{channelId}`
- `live-checker` runs server-side so notifications fire even when the dashboard tab is closed
- `app.js` exposes `channels` as a module-level global — Codex reads it directly in `backtest.js`
