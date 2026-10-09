# bubbaonline

Last online is shown on the character list and profiles. Online players show
"Online now"; offline players show when they were detected going offline, in the
visitor's local time zone. This is approximate and depends on the online polling
interval. Characters without a recorded offline transition show "Unknown".
Historical timestamps and imported deaths are not used to infer online activity.

Apply database migrations before deploying the Worker:

```sh
npx wrangler d1 migrations apply bubbaonline --remote
npm run deploy
```

Migration `0003_last_online.sql` adds a nullable column without backfilling history.
Tracking begins when the updated Worker receives online updates.

Power Gamers (`/power-gamers`) ranks the top 10 estimated net EXP totals over a rolling
24 hours. The first online observation establishes a baseline without awarding
EXP, including for existing and death-only characters. Upward changes record the
difference between the two cumulative EXP thresholds. A level loss lowers the
baseline; regaining those levels counts as a new gross gain. Baselines survive
reconnects. Net EXP is gross observed gains minus estimated death losses, using
the rounded midpoint of each death's loss range. This midpoint is a ranking
convention, not an inference about blessing counts. The API also returns gross
gains, losses, and the resulting net range. Negative totals are red, positives
green, and zero neutral. Death-only characters are eligible. The top 10 limit is
applied after net totals are calculated, ordered highest first.

The EXP curve is `(50 * level^3 - 300 * level^2 + 850 * level - 600) / 3`, matching
the supplied level 1–300 table and extending the same curve above level 300.
Progress within a level is unknown. Changes are timestamped when detected, so
changes discovered after a monitoring gap are attributed to that observation,
not an exact historical time. No history is backfilled at deployment.

Migration `0005_power_gamers_efficiency.sql` moves any existing progress baseline
onto the character row, removes the separate baseline table, and records only
positive changes. Apply all pending migrations before deploying the updated Worker.

The free-tier-conscious implementation:

- Reuses the existing online character read and level update. Unchanged heartbeats
  add no reads or writes for Power Gamers. Initial baselines need a one-time write
  for already-online characters. Level losses add no gain-history rows.
- Adds one gain-history row and its timestamp index entry per observed upward
  change. Index entries and eventual deletions also count as D1 writes.
- Reads indexed 24-hour gain and death windows on cache misses. Both sets of
  active characters are combined before ranking, so loss-only characters and
  players outside the old gross-gain top 10 are considered.
- Caches rankings for five minutes with the Workers Cache API; each data centre
  has its own cache and may evict it early. Hits do not query D1. This reduces
  traffic-dependent reads but is not a strict global query cap.
- Refreshes the page every five minutes and skips polling while hidden.
- Prunes up to 100 history rows older than 48 hours when recording a new gain,
  bounding cleanup work without a separate scheduled Worker. Old rows can remain
  during inactivity; subsequent gains resume cleanup. Baselines are retained.
- Returns actual D1 `rowsRead` and `rowsWritten` totals from online updates, including
  the initial read and batched writes. The older `writes` field counts statements.

Cloudflare's documented free D1 allowance is 5 million rows read/day and 100,000
rows written/day, with 500 MB per database and 5 GB total account storage. Workers
Free also allows 100,000 requests/day. These are account allowances shared with
other projects, not guaranteed capacity for this application. Current references:
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Death entries show an estimated loss range using stock TFS 1.2's
`deathLosePercent = -1` formula, assuming promotion and allowing 0–5 blessings.
Article-prefixed killers (`a ...`/`an ...`) are treated as monsters; other names
also allow the stock PvP unfair-fight multiplier of 20–100%. This convention is
only a heuristic: custom loss rules, monster names, and summons can differ.
The model is based on [TFS 1.2 player.cpp](https://github.com/otland/forgottenserver/blob/1.2/src/player.cpp#L3612).

Migration `0006_death_observations.sql` saves a small snapshot only when an
observed level decreases. It prunes up to 100 snapshots older than 48 hours on
each subsequent decrease. Correlation runs after online changes/logins or new
death imports, never on unchanged heartbeats or repeat death imports. It batches
character lookups and only writes death rows whose matched observation changed.
This adds snapshot/index writes per decrease and reads when activity changes;
it does not require per-minute snapshot writes.

A death can match a decrease only if its recorded level matches the previous
online level, it falls after the previous observation and within 120 seconds of
the new observation, and there is only one known death in that interval.
Either arrival order works. A newly discovered second death invalidates an
ambiguous match. Matches are stored on death rows and survive snapshot cleanup.
All timestamps currently assume the deathlist clock is UTC, as in the existing
importer. A different server timezone must be normalized before correlating.

A compatible observation bounds post-death EXP from above, since hunting may
have resumed before the poll. This can narrow both the loss and pre-death EXP
ranges. Conflicting observations fall back to the broad model range. Estimates
are calculated in memory. For Power Gamers, each recorded death contributes one
loss deduction, and observed level decreases are not deducted a second time.
Exact EXP and blessing counts are not inferred. The net range reflects uncertainty
in death losses only; gross level-based gains remain approximate too.

Migration `0007_death_ranking_index.sql` indexes death timestamps for the rolling
window, adding an index write per new death without new heartbeat writes. The
ranking still uses the five-minute cache, with a new cache key to avoid serving
old gross-only responses after deployment. Deaths use their recorded time, while
gains use observation time. Existing deaths in the last 24 hours can contribute
losses even when gain tracking has only recently started.
