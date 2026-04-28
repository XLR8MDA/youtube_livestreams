# Sprint 2 — Pairs, Analysis & Notifications
**Status:** Complete  
**Date:** 2026-04-28

---

## Goals
1. Currency pair dropdown per channel (global shared list + custom pairs)
2. YouTube stream transcript → Groq LLM → trade timestamp markers
3. Fix live notifications (Telegram missing stream title/link + add browser push)

---

## Delivered

### Claude
| File | What it does |
|---|---|
| `netlify/functions/custom-pairs.js` | GET/POST/DELETE global custom pairs list — NeonDB key `'custom-pairs'` |
| `netlify/functions/transcript.js` | GET transcript for any videoId via `youtube-transcript` npm package — returns `[{ text, offset }]` (offset in seconds) |
| `netlify/functions/analyze-stream.js` | GET/POST — fetches transcript, sends to Groq (`llama-3.3-70b-versatile`), returns trade markers `[{ ts, label, type }]`, caches result in NeonDB key `analysis__{videoId}` |
| `app.js` | Added: `DEFAULT_PAIRS` (10 pairs), `customPairs` state, `loadCustomPairs()`, `saveCustomPairs()`, `setPairForChannel()`, `addCustomPair()`, updated `renderChannelList()` with pair dropdown + inline add-pair form, `requestNotificationPermission()`, `notifyChannelLive()`, live-transition detection in `refreshAllChannels()` |
| `live-checker.js` | Search now fetches `id,snippet` to capture stream title; Telegram message now includes stream title + direct YouTube link; manual GET trigger exposed for debugging; better env var error logging |
| `package.json` | Added `youtube-transcript ^1.2.1` |

### Codex
| File | What it does |
|---|---|
| `style.css` | CSS for `.ch-pair-row`, `.ch-add-pair-row`, marker chips, timeline strip |
| `backtest.js` | `analyzeStream()`, marker chip rendering, `player.seekTo()` on chip click, stream meta/pair badges, Analyze button with loading state |
| `index.html` | Analyze button wired into the stream player area |

---

## Key Decisions
- **Pairs are global** — one shared list, each channel independently selects its active pair
- **Groq over xAI Grok** — user provided Groq key (`gsk_...`); using `llama-3.3-70b-versatile` (131k context)
- **Transcript caching** — analysis result stored in NeonDB so Groq is not called twice for the same video
- **Browser notifications** — use native `Notification` API (no service worker), fall back to on-screen toast if permission denied
- **Chunking** — transcripts over 180k chars split into segments, markers merged and sorted by timestamp

## Env Vars Added
| Var | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq inference API — model `llama-3.3-70b-versatile` |
