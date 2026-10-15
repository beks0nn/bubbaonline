# API

All imports use the existing `?key=YOUR_SECRET` authentication and JSON bodies.
Use your `OTCLIENT_SECRET` value, URL-encoded, as the key. No authentication
header is required. Reads are public.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/characters` | Import 1–100 full character profiles |
| POST | `/api/highscores` | Replace one skill's complete ranking snapshot |
| GET | `/api/highscores?skill=magic` | Read a skill ranking |
| POST | `/api/online` | Existing complete online snapshot; now accepts `observed_at` |
| POST | `/api/deathlist` | Existing deathlist text import, unchanged |
| GET | `/api/characters` | Character list, now including profile fields |
| GET | `/api/characters/:name` | Profile, deaths and current ranked skills |
| GET | `/api/online` | Current online players |
| GET | `/api/top-frags` | Existing frag ranking |
| GET | `/api/power-gamers` | Existing top 10 estimated net EXP ranking |

`PATCH /api/characters/vocation` has been removed and returns 404. Import
vocations through profiles or highscores instead. Keep both online and deathlist
imports: neither new command replaces those feeds.

## Character profiles

```http
POST /api/characters?key=YOUR_SECRET
```

```json
{
  "observed_at": "2026-10-14T22:15:00+02:00",
  "characters": [
    {
      "name": "bksonn",
      "level": 179,
      "vocation": "Elite Knight",
      "city": "Carlin",
      "guild": null,
      "sex": "male",
      "account_type": "premium",
      "last_online": "2026-10-14T22:10:00+02:00",
      "status": "online"
    }
  ]
}
```

- `observed_at` is when the command was collected, not when it was uploaded.
  Each character may override it with its own `observed_at` when commands were
  collected at different times. Send timestamps with seconds and an explicit
  timezone (`Z` or an offset); stored and returned values are normalized to UTC.
  The example assumes the command's clock uses UTC+02:00. Convert using the actual
  server timezone, including daylight saving where applicable.
- Required fields: `name`, positive integer `level`, `vocation`, `status`
  (`online`/`offline`), and `last_online` (timestamp or `null`). Map the command's
  **Last login** to `last_online`; there is one Last online display.
- Optional `city`, `guild`, `sex`, and `account_type` are cleared to null when
  omitted or explicitly null. Send full profiles. `guild: "None"` also becomes
  null. `sex` accepts `male`/`female`; `account_type` accepts `premium`/`free`.
- A null `last_online` preserves a known value. A timestamp can advance it but
  cannot move it backwards. Polling still records later offline transitions.
  Online players display **Online now**; otherwise a missing date shows **Unknown**.
- Vocations accept full names or `K`, `EK`, `P`, `RP`, `S`, `MS`, `D`, `ED`,
  case-insensitively. `None` and `Unknown` are also accepted. Stored values use
  full names. Profiles take precedence over highscore vocation information.
- Names are trimmed and must contain 1–64 characters without control characters.
  Use the same spelling and capitalization across feeds. Duplicate names within
  a batch are rejected, including names differing only by capitalization.

Only newer profiles update an existing profile. Repeating an identical capture
timestamp is a no-op, including if its contents differ. A partial batch affects
only its named characters. An older profile may enrich descriptive fields but
cannot replace activity from a newer online snapshot. At equal capture times,
the profile takes precedence over the online feed.

Profiles and online updates share one EXP baseline. The first observed real level
sets the baseline; a subsequent increase counts once, irrespective of which feed
reports it. Level losses lower that baseline, so recovery still counts as gains.
Highscore skill values never contribute character EXP.

The response includes `ok`, `count`, `updated`, `writes`, `rowsRead`, `rowsWritten`.
`updated` counts accepted new or newer profiles, including freshness-only updates.

## Skill highscores

```json
{
  "skill": "magic",
  "observed_at": "2026-10-14T22:15:00+02:00",
  "entries": [
    { "rank": 1, "name": "addinator", "value": 84, "vocation": "MS" },
    { "rank": 2, "name": "Shroud", "value": 78, "vocation": "MS" }
  ]
}
```

Send to `POST /api/highscores?key=YOUR_SECRET`. Supported skills: `magic`, `sword`, `club`,
`shielding`, `distance`. `value` is a non-negative integer skill value, never
the character's level. Include the entire command result, up to 50 entries,
with unique names and consecutive ranks starting at 1. This is separate from
Power Gamers, which remains top 10.

An accepted snapshot replaces only that skill's ranking. Missing entries are
removed from that ranking; their characters and other skills are retained.
An empty array clears the ranking, so do not upload an empty snapshot when a
command fails or its response is incomplete. Older/equal timestamps are ignored.

Characters first discovered through highscores have an unknown character level
(`null` in GET responses) until a profile or online observation supplies it.
Character detail responses include `skills`, an array of current ranked entries
with `skill`, `rank`, `value`, and `observed_at`. Absence from a ranking does not
mean a skill is zero. The website displays these entries on character profiles.

The import response includes `ok`, `skill`, `count`, `ignored`, and write/read
metrics. `count` is the submitted entry count, even if the snapshot was ignored.

`GET /api/highscores?skill=magic` returns:

```json
{
  "skill": "magic",
  "observed_at": "2026-10-14T20:15:00.000Z",
  "entries": [
    { "rank": 1, "name": "addinator", "value": 84, "vocation": "Master Sorcerer" },
    { "rank": 2, "name": "Shroud", "value": 78, "vocation": "Master Sorcerer" }
  ]
}
```

Before a skill's first import, `observed_at` is null and `entries` is empty.

## Existing online importer

The existing payload still works. Add `observed_at` to protect delayed uploads:

```json
{
  "observed_at": "2026-10-14T22:15:00+02:00",
  "players": [{ "name": "bksonn", "level": 179 }]
}
```

Without `observed_at`, receipt time is used. The list is still a **complete**
online snapshot. Older/equal captures are ignored. The response adds `ignored`
alongside existing counters; `levelChanges` counts existing character level or
baseline updates, including reconnects. Gains use the capture timestamp.

## Database cost and refresh behavior

- Full snapshots use bulk SQL and one timestamp row per feed, rather than
  rewriting every player each minute. An unchanged newer online poll or
  highscore snapshot writes one timestamp row; first creation also writes its
  primary-key index. One-minute online polling adds about 1,440 timestamp
  writes/day. Exact timestamp retries write nothing.
- Newer profiles update their per-character freshness timestamp even if all
  profile fields are unchanged. Import profiles when collected; there is no
  new server-side polling job. Avoid refreshing every known profile every minute.
- Only changed highscore rows are rewritten. A practical starting schedule is
  one snapshot per skill every 15–60 minutes, with profile refreshes on discovery
  or a slower schedule. Total cost still depends on player count and activity;
  monitor the returned D1 row metrics.
- `writes` counts import statements that wrote rows. `rowsWritten` includes
  indexes and trigger writes; `rowsRead`/`rowsWritten` also include death
  correlation work. These metrics cover D1, not Cache API operations.
- Highscore GET responses are cached for up to five minutes per Cloudflare
  data centre. Imports clear that skill's cache in the handling data centre;
  other centres may serve their cached response until expiry. Cache eviction
  is safe: a miss reads the stored ranking. Cache hits do not read D1.
- Profile and highscore imports reject malformed or invalid data with 400 before
  writing any rows. Authentication failures return 401. Unknown API routes,
  including the removed PATCH route, return 404.

Apply migration `0008_profiles_highscores.sql` before deploying this Worker.
It preserves existing characters, deaths and EXP history. No new bindings are required.

```powershell
npx.cmd wrangler d1 migrations apply bubbaonline --remote
npm.cmd run deploy
```
