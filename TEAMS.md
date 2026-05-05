# TEAMS — Claude + Codex Working Space
> Active messages and handoffs only. Completed sprint work lives in `sprints/`. Architecture lives in `context.md`.

---

## Current Sprint
**Post-Sprint 3** — UI Declutter + Course Tab

---

## Codex Task Queue

| # | Task | Status |
|---|------|--------|
| 1 | Remove broken Analytics card from Backtest tab | pending |
| 2 | Fix analysis panel pre-showing on stream select | pending |
| 3 | Remove useless Paste (Ctrl+V) button from screenshot zone | pending |
| 5 | Build Course tab — playlist viewer with progress tracking | pending |
| 6 | Save trade screenshots to Google Drive | pending |

---

## Task Details

### #1 — Remove broken Analytics card from Backtest tab
In `index.html`, remove the entire `.analytics-card` div (the second `backtest-card` in `.backtest-main`). It only shows single-stream stats but is labelled "Aggregated journal stats" — misleading. Real stats live in the Stats tab.  
In `backtest.js`, remove: `loadChannelAnalytics`, `clearAnalytics`, `computeStats`, `renderAnalyticsTable` functions plus all calls to them.  
In `style.css`, remove `.analytics-card` rule.

---

### #2 — Fix analysis panel pre-showing on stream select
In `backtest.js`, in `selectStream()`, change `resetAnalysisState()` → `resetAnalysisState(true)` so the analysis panel stays hidden until the user explicitly clicks Analyze.

---

### #3 — Remove useless Paste button from screenshot zone
In `index.html`, remove the `btn-paste-screenshot` button from inside `.screenshot-btns`.  
In `backtest.js`, remove the `pasteBtn` variable and its click handler inside `setupScreenshotPaste`.  
Global paste listener and drag-drop/upload must remain intact.

---

### #5 — Build Course tab — playlist viewer with progress tracking
Full curriculum viewer built from `course.md`.

**Playlist IDs (hardcode in `course.js`):**
| Tag | Playlist ID |
|-----|-------------|
| SMC Part X | `PLyobF5Rf4liTQrcKtSmbwaCtX71lUP-n_` |
| Bootcamp Ep.X | `PLguWwLNVYKWfGzKcW358QivkQceAtW5B-` |
| Zip 3 | `PLguWwLNVYKWeGlaKrhB3Tp9MfMmj7BlQg` |

**New Netlify function:** `netlify/functions/course-playlist.js`
- `GET /.netlify/functions/course-playlist?playlistId=PLxxx`
- Fetches all pages via YouTube Data API (`YOUTUBE_API_KEY` env var, same as other functions)
- Returns `{ items: [{ videoId, title, thumbnail, position }] }`
- Cache in NeonDB `dashboard_state` key `course-playlist-{playlistId}` with 24h TTL

**New file:** `course.js`
- On tab activation fetch all 3 playlists in parallel
- Lesson list hardcoded from `course.md` (34 lessons across 5 phases)
- Each lesson row: number, title, source badge, Watch button
- Watch button loads video in embedded right-side YT player
- Completed lessons stored in `localStorage` key `course_completed` (array of lesson numbers)
- "Mark complete" button toggles; completed = green checkmark + strikethrough
- Phase sidebar shows per-phase progress ("3/6 done") and a progress bar

**`index.html`:** Add `<button id="tab-course" class="tab-btn" data-tab="course">Course</button>` to `#tab-nav`. Add `<section id="course-panel" class="hidden">` with 3-column layout (sidebar 220px | lesson list 1fr | player 320px). Add `<script src="course.js"></script>` before `</body>`.

**`backtest.js` `switchTab`:** Add `isCourse` branch, hide/show `#course-panel`, call `onCourseTabActivated()` if defined.

**`style.css`:** Source tag badge colors — SMC = blue (`#2260b0`), Bootcamp = green (accent), Zip 3 = teal (accent-2).

---

### #6 — Save trade screenshots to Google Drive
Auto-save chart screenshots from the trade journal to user's Google Drive after extraction.

**New Netlify function:** `netlify/functions/save-to-drive.js`
- POST `{ imageBase64, mimeType, filename }` → `{ ok, fileId, webViewLink }`
- Filename format: `trade_{channelId}_{streamId}_{timestamp}.png`
- Uploads to Drive folder "MultiPlay Trades" (create if not exists)
- Reads OAuth2 refresh token from NeonDB `dashboard_state` key `google-drive-token`
- Refreshes access token per call using `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`

**New Netlify function:** `netlify/functions/drive-auth.js`
- GET (no `code` param) → redirect to Google OAuth consent screen (Drive scope)
- GET `?code=...` → exchange for refresh token, save to NeonDB, return success page

**Env vars needed:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

**`backtest.js`:** After `processScreenshot()` extraction succeeds, call `save-to-drive` in the background (fire-and-forget, non-blocking). On success: append "Saved to Drive ↗" link to `screenshot-status`. On failure: warn toast only.

**`index.html`:** Add a "Google Drive" section in `#modal` below the channel list — a "Connect Google Drive" link pointing to `/.netlify/functions/drive-auth` opening in a new tab.

---

## Session Log

**2026-05-05 (Claude)**
- **Relational Backfill:** Migrated legacy `dashboard_state` blobs (journal, analysis, channels, pairs, live-state) to new relational tables.
- **Google Drive Integration (#6):** Implemented `drive-auth.js` and `save-to-drive.js` for trade screenshot archival.
- **Fixed manual stream tracking:** `live-checker.js` and `app.js` now respect `manual_video_id` to prevent auto-search overwriting manual URLs.
- **Cleaned up UI:** Deleted obsolete `stream-log-ui.js` script; removed auto-polling and Quota Widget from `app.js` and `index.html`.
- **Fixed Vision Model:** Switched `extract-trade.js` to `llama-3.2-11b-vision-preview`.
- **Course Tab Fix:** Added missing `PLAYLIST_IDS` to `course.js`.


---

## Previous Inbox (archived)

**2026-04-28 (Claude → Codex):** Stream Log tab spec (now deleted — tab removed 2026-05-05)

**2026-04-29 (Codex):** Drafted sprint-4.md for NeonDB relational migration.
