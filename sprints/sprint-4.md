# Sprint 4 — NeonDB Relational Migration
**Status:** Complete  
**Date:** 2026-04-29

---

## Goal
Replace the current JSON-blob storage model in NeonDB with a proper relational schema for core application data, so analytics, reporting, and future growth do not depend on scanning and rewriting large `JSONB` blobs in `dashboard_state`.

This sprint is about moving NeonDB from "persistent document store" usage to "actual database" usage.

---

## Why This Sprint Exists
The current storage model is fast to ship but weak long-term:
- Journal analytics scan every `journal__*` blob and aggregate in memory
- Queries by `channelId`, `pair`, `result`, and date are inefficient
- Updates rewrite whole JSON arrays instead of single rows
- Concurrent writes can overwrite each other
- There are no relational constraints or useful indexes on business data

This is acceptable for a prototype, not for a durable app with growing history.

---

## Primary Objectives
1. Move **journal data** to relational tables first
2. Move **stream log** to relational tables second
3. Move **channels** and **custom pairs** off `dashboard_state`
4. Keep only flexible payloads such as marker arrays as `JSONB`
5. Add one-time backfill from old blob keys into the new schema
6. Switch analytics from JSON scans to SQL aggregations

---

## Target Schema

### `channels`
```sql
channel_id   TEXT PRIMARY KEY,
name         TEXT NOT NULL,
handle       TEXT,
is_active    BOOLEAN NOT NULL DEFAULT TRUE,
created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `custom_pairs`
```sql
id           BIGSERIAL PRIMARY KEY,
label        TEXT NOT NULL,
value        TEXT NOT NULL UNIQUE,
created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `journal_entries`
```sql
id              TEXT PRIMARY KEY,
channel_id      TEXT NOT NULL,
stream_id       TEXT NOT NULL,
stream_title    TEXT,
pair            TEXT,
direction       TEXT NOT NULL,
result          TEXT NOT NULL,
entry_price     DOUBLE PRECISION,
exit_price      DOUBLE PRECISION,
stop_price      DOUBLE PRECISION,
rr              DOUBLE PRECISION,
notes           TEXT,
video_timestamp INTEGER,
created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `stream_analysis`
```sql
video_id      TEXT PRIMARY KEY,
channel_id    TEXT NOT NULL,
markers       JSONB NOT NULL,
analyzed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `stream_log`
```sql
id            BIGSERIAL PRIMARY KEY,
video_id      TEXT NOT NULL UNIQUE,
channel_id    TEXT NOT NULL,
channel_name  TEXT,
stream_title  TEXT,
ended_at      TIMESTAMPTZ NOT NULL,
analyzed_at   TIMESTAMPTZ,
status        TEXT NOT NULL,
has_traces    BOOLEAN NOT NULL DEFAULT FALSE,
marker_count  INTEGER NOT NULL DEFAULT 0,
markers       JSONB NOT NULL DEFAULT '[]'::jsonb,
created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `live_state`
```sql
channel_id         TEXT PRIMARY KEY,
is_live            BOOLEAN NOT NULL DEFAULT FALSE,
last_video_id      TEXT,
stream_title       TEXT,
last_notified_at   TIMESTAMPTZ,
updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

---

## What Stays as JSONB
- `stream_analysis.markers`
- `stream_log.markers`
- Optional future cached payloads

Everything else that drives filtering, aggregation, or reporting should be typed columns.

---

## Migration Phases

### Phase 1 â€” Journal First
Highest priority because all trading analytics depend on it.

#### Backend
- Create `journal_entries`
- Update `netlify/functions/journal.js` to CRUD rows instead of `journal__{channelId}__{streamId}` blobs
- Update `netlify/functions/journal-dashboard.js` to aggregate via SQL instead of scanning `dashboard_state`

#### Frontend
- Keep the current journal UI contract unchanged if possible
- Preserve current response shapes so `backtest.js` needs minimal change

#### Success Criteria
- Add/edit/delete journal entry works
- Channel analytics still render
- Global stats dashboard reads from SQL

---

### Phase 2 â€” Stream Log

#### Backend
- Create `stream_log`
- Update `netlify/functions/stream-log.js` to query rows grouped by date
- Update `netlify/functions/auto-analyze.js` to insert/update one row per analyzed stream

#### Success Criteria
- Stream Log tab still loads by days/channel
- No more `stream-log` array blob growth in `dashboard_state`

---

### Phase 3 â€” Channels and Custom Pairs

#### Backend
- Create `channels`
- Create `custom_pairs`
- Update `netlify/functions/channels.js`
- Update `netlify/functions/custom-pairs.js`

#### Success Criteria
- Channel list persists correctly
- Pair list persists correctly
- Existing UI continues to work

---

### Phase 4 â€” Analysis Cache and Live State

#### Backend
- Create `stream_analysis`
- Create `live_state`
- Update `netlify/functions/analyze-stream.js`
- Update `netlify/functions/live-checker.js`

#### Success Criteria
- Cached analysis still hits instantly on repeat
- Live notification dedupe still works

---

## Backfill Strategy
One-time migration logic should:
- Read existing `dashboard_state` keys
- Insert relational rows if they are missing
- Be safe to run more than once
- Avoid deleting old blob data until verification is complete

Backfill order:
1. `journal__*` + `journal-index__*`
2. `stream-log`
3. `channels`
4. `custom-pairs`
5. `analysis__*`
6. `live-state` / equivalent live checker data

---

## Compatibility Strategy
For a short transition period:
- Prefer reads from new SQL tables
- Optionally fall back to old blob keys if SQL rows are missing
- Stop writing blobs once SQL is verified
- Remove fallback after migration is confirmed stable

This avoids a hard cutover failure if partial data exists.

---

## Ownership Split

### Claude
| File / Area | Responsibility |
|---|---|
| `netlify/functions/journal.js` | Move journal CRUD to `journal_entries` |
| `netlify/functions/journal-dashboard.js` | Move aggregations to SQL |
| `netlify/functions/stream-log.js` | Read `stream_log` table |
| `netlify/functions/auto-analyze.js` | Write `stream_log` rows |
| `netlify/functions/channels.js` | Move channel persistence to `channels` table |
| `netlify/functions/custom-pairs.js` | Move pair persistence to `custom_pairs` table |
| `netlify/functions/analyze-stream.js` | Move analysis cache to `stream_analysis` |
| `netlify/functions/live-checker.js` | Move notification state to `live_state` |
| DB migration SQL | Table creation, indexes, constraints, backfill |

### Codex
| File / Area | Responsibility |
|---|---|
| `index.html` | Any new admin/migration status panels if needed |
| `style.css` | Styling changes if dashboard output changes |
| `backtest.js` | Adjust frontend only if API response shapes change |
| `analytics-dashboard.js` | Adapt stats dashboard if backend output changes |
| QA support | Validate tab flows after backend migration |

---

## Verification Checklist
- Journal entry create/update/delete still works
- Backtest analytics still load
- Stats dashboard still loads
- Stream Log still groups correctly by day
- Pair selection and custom pair addition still persist
- Live channel detection still works
- Analysis caching still works
- No feature depends on stale `dashboard_state` blobs after cutover

---

## Risks
- Partial migration causing split-brain data between blobs and tables
- Backfill duplication if idempotency is not enforced
- Frontend breakage if API response contracts change unexpectedly
- Scheduled functions writing old format while API functions read new format

Mitigation:
- Migrate journal first
- Keep response shapes stable
- Add idempotent inserts / upserts
- Restart local `netlify dev` after adding new migration/functions

---

## Exit Condition
Sprint 4 is complete when:
- Core app data is stored in relational tables instead of JSON blobs
- Analytics run from SQL, not JSON scans
- Old blob writes are removed for migrated entities
- `dashboard_state` is only used for intentionally flexible cache-like data, if at all
