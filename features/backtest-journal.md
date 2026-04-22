# Feature: Backtest + Trade Journal

## Phase 1 — Video Playback
- [ ] Add tab navigation to `index.html` (Live Dashboard | Backtest)
- [ ] Create backtest panel layout (channel picker + video player + sidebar)
- [ ] Add `netlify/functions/past-streams.js` — calls YouTube `search.list` with `eventType: completed` to fetch past livestreams for a channel
- [ ] Render list of last 10 completed streams for the selected channel
- [ ] Play selected stream via existing YT IFrame player
- [ ] Add "Load next 10" pagination button

## Phase 2 — Trade Journal
- [ ] Design trade entry form (Direction, Entry Price, Exit Price, Result, Notes)
- [ ] Auto-capture current video timestamp when logging a trade
- [ ] Add `netlify/functions/journal.js` — GET/POST journal entries (stored in Netlify Blobs, keyed by channelId + streamId)
- [ ] Save journal entries to Netlify Blobs on submit
- [ ] Show journal entries list for the current stream session
- [ ] Allow editing and deleting a journal entry

## Phase 3 — Analytics & Overview
- [ ] Design data schema for aggregated results (trades per channel, per group)
- [ ] Channel-wise stats page: total trades, win rate, avg R, best/worst stream
- [ ] Group/team tagging: allow channels to be tagged into groups (e.g. "ICT", "SMC")
- [ ] Team-wise aggregated stats: same metrics rolled up per group
- [ ] "What works best for me" overview: ranked table of channels/groups by win rate
- [ ] Simple bar chart for win/loss breakdown (no extra library — pure CSS or Canvas)
