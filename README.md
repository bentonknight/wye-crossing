# Wye Level Crossing — live status & closure planner

Estimates barrier status at the Wye level crossing (Bridge Street, Kent) from
live National Rail data, with a "Plan ahead" view showing closures for any day
up to two weeks out, and an authoritative override for planned road closures
from DfT Street Manager.

## Data sources, in priority order

**Live view** — Darwin boards every 60s (barriers down 3 min before a train).
Fail-safe: no trains during service hours ⇒ STATUS UNKNOWN, not "open".

**Plan ahead — future days:**
1. **Published timetable** (Network Rail SCHEDULE, ingested daily) — the source
   of truth. Includes timetable *changes* weeks ahead, so the autumn change
   shows correctly with no lag.
2. **Learned pattern** (fallback) — built by `record.mjs` from live observations.
   Used only if the published feed is missing or stale (>36h old).
3. If neither exists, the day honestly says so.

When on fallback, the sheet shows an amber "live timetable data unavailable"
note — quiet reassurance to villagers, a signal to you to check the ingest.

## Files

```
index.html                     App (live view + Plan ahead)
netlify.toml                   Build config + /api routes
package.json                   Netlify Blobs dependency
closures.json                  Manual road closures (fallback / testing)
icons + manifest.json          Home-screen assets
netlify/functions/
  sns.mjs        Street Manager SNS receiver     -> /api/sns
  closures.mjs   Serves road closures            -> /api/closures
  record.mjs     SCHEDULED: learns timetable      (fallback source)
  schedule.mjs   Serves learned pattern          -> /api/schedule
  timetable.mjs  Receives daily ingest / serves  -> /api/timetable
ingest/
  ingest-schedule.mjs          Downloads SCHEDULE, filters to Wye, posts forward
.github/workflows/ingest.yml   Runs the ingest daily at 06:30 UTC
```

## Setup for the published timetable

### 1. GitHub secrets  (repo → Settings → Secrets and variables → Actions)
Add four repository secrets:
- `NR_USER` — Network Rail Open Data username
- `NR_PASS` — Network Rail Open Data password
- `INGEST_URL` — `https://YOUR-SITE.netlify.app/api/timetable`
- `INGEST_KEY` — a long random string you invent (e.g. from a password manager)

### 2. Netlify environment variable
Netlify → Site configuration → Environment variables → add
`INGEST_KEY` = **the same string** as the GitHub secret. Redeploy.

### 3. First run
GitHub → Actions → "Daily Wye timetable ingest" → **Run workflow**. Then:
- Check the run succeeds (green tick).
- Visit `https://YOUR-SITE.netlify.app/api/timetable` — should show JSON with a
  recent `generated` timestamp and a `days` object.
- Open the app → Plan ahead → a future day should read "From the published
  timetable."

### 4. Failure alerts
GitHub emails you automatically when a scheduled Action fails. The ingest exits
non-zero if the download breaks OR if the result looks empty (sanity check), so
both hard failures and silently-empty data reach your inbox. No setup needed
beyond having GitHub notifications on.

## Street Manager (road closures) — unchanged
See earlier setup: `WYE_USRN` env var + free Open Data registration, endpoint
`https://YOUR-SITE.netlify.app/api/sns`. Until then edit `closures.json`.

## Tuning (index.html)
- `DOWN_BEFORE` 180s, `UP_AFTER_PASS`/`UP_AFTER_STOP` — barrier model.
- `PUBLISHED_STALE_HOURS` 36 — how old published data can get before fallback.
- `OFF_AFK`/`OFF_CBW` — offsets used by the live view and the learner.

## Ingest tuning (ingest/ingest-schedule.mjs)
- `WYE_TIPLOC` = WYEE, `DAYS_AHEAD` = 14.
- `TIPLOC_NAMES` — friendly destination names; unknown codes fall back to raw.
- If the JSON feed shape differs in practice, `collectSchedules()` is where to
  adjust field names. Verify Wye times against reality after first run.

## Limits
- Barrier status is estimated; no public gate sensor.
- Ingest sees planned schedules, not same-day short-notice changes (VSTP).
- Street Manager covers England; depends on the promoter registering closures.
- Always obey the lights and barriers at the crossing.
