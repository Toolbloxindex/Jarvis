# Deploying Housewatch on free tiers (Vercel Hobby + Supabase Free)

Checked against the official docs on 2026-11-25.

## The constraints that shape everything

| Service | Limit that matters | Consequence |
| --- | --- | --- |
| Vercel Hobby | 4 Active-CPU hours, 360 GB-hours memory and 1M invocations per month. Functions run up to 300 s with 2 GB. | Going over **pauses every deployment for about 30 days**. The collector must not run on Vercel. |
| Vercel Hobby cron | At most once a day, timing only accurate to the hour | Useless for frequent polling |
| Vercel Hobby | Non-commercial use only | Commercial use needs Pro |
| Vercel image optimisation | 5k transformations a month | Remote listing photos bypass it (our custom loader returns source URLs unchanged) |
| Supabase Free | 500 MB database, 5 GB egress, 1 GB storage, 2 projects | Keep snapshots pruned. Don't proxy photos. |
| Supabase Free | Pauses after 7 days of low activity | The collector's regular writes keep it awake |
| Supabase Edge Functions | 2 s of CPU per request | Too little for HTML parsing, so the collector doesn't run there |
| GitHub Actions on a public repo | Unlimited minutes. Schedules run every 5 minutes at the fastest, but runs can start late or be dropped. Schedules are disabled after 60 days without repo activity. | The collector runs here |

`Toolbloxindex/Jarvis` is **public**, so Actions minutes are free.

## Architecture

```
GitHub Actions (every 15 min, Node 24)        Supabase (Postgres)            Vercel (Hobby)
  collect job ─ runPublicDiscovery ──upsert──▶ listings, sources,     ◀─select── /listings (static shell,
             ─ travel for new or moved ads          listing_history,                  'use cache' + tag "listings")
               (bounded budget per run)         travel_cache, runs
             ─ POST /api/revalidate ───────────────────────────────────────────▶ revalidateTag("listings", { expire: 0 })
```

1. **The collector runs in GitHub Actions.** `.github/workflows/collect.yml` triggers on `*/15 * * * *` and also by hand (`workflow_dispatch`).
   - A `concurrency` group ensures only one collector runs per database.
   - The collector still honours each source's own *next due* time, robots rules and pacing. A 15-minute trigger therefore doesn't mean hitting every site every 15 minutes.
   - Each run writes to Supabase through the transaction pooler (port 6543, `prepare: false`) using the pooler connection string with database credentials, stored as a GitHub secret.
2. **The collector calculates travel for new or moved listings** through FOSSGIS, within a budget of 10 per run by default. Excess work stays queued. Vercel returns cached travel by default. With a server-only pooler credential, on-open POST can calculate travel and applies a 24-hour per-listing cooldown.
3. **Vercel only serves the app.** `/listings` keeps its static shell, and the feed is read with `'use cache'` + `cacheTag("listings")`. After a changed run, the collector calls `POST /api/revalidate` with a bearer token. The handler calls `revalidateTag("listings", { expire: 0 })` and the next page visit refreshes the feed. The long `days` profile provides a time-based fallback.
4. **Supabase holds the data.**
   - Tables include `sources`, `listings`, `listing_sources`, `listing_history`, `travel_cache`, `amenities`, `collector_runs`, and `settings`.
   - RLS protects all tables. The anon key gets SELECT access to curated listing and amenities views and a timestamp-only freshness view.
   - The collector writes through the transaction pooler with its database credential. An HTTP service role key is unnecessary.
   - The prune job runs daily at 03:00 UTC and keeps a 12-month history.
5. **Photos:** we store the source URLs only and never proxy or optimise them through Vercel.

## Budget check

- **Vercel CPU:** page renders are cached. Each revalidation is roughly 50–200 ms, so 96 runs a day × 30 days × about 0.2 s is roughly 10 CPU-minutes a month, against a 240-minute allowance.
- **Supabase:** about 25 KB per listing with history means 10k listings is roughly 250 MB. Prune history older than 12 months.
- **Staleness:** the collector stores `collector_runs.finished_at`. The feed exposes the latest finished run as `updatedAt` for the UI to display.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| GitHub delays or drops scheduled runs | `workflow_dispatch` lets cron-job.org (1-minute precision, free) trigger runs. The scheduled trigger stays as a backup. |
| Sources block GitHub runner IP addresses | The per-source access failure backoff already exists. Show source status in the UI. |
| Vercel overage pause | No collector or cron on Vercel. Watch the Usage page. Remote images are unoptimised. |
| Supabase pausing | The collector writes at least every few hours |
| Public repo | No secrets in code. The owner profile is neutralised. Fixtures contain no personal data. |

## What needs your access

1. Create a Supabase project and apply `jarvis/supabase/migrations/0001_housewatch.sql` in the SQL editor. Copy the transaction pooler URL on port 6543 from **Connect**, using the database password in the URL. Take the HTTPS project URL and anon key from the project settings.
2. Add these GitHub Actions repository secrets after the workflow is in the repository.

   | Secret | Value |
   | --- | --- |
   | `SUPABASE_DB_URL` | Supabase transaction pooler connection string |
   | `HOUSEWATCH_REVALIDATE_URL` | `https://<app>.vercel.app/api/revalidate` |
   | `HOUSEWATCH_REVALIDATE_TOKEN` | Random bearer token shared with Vercel |

   The workflow sets `HOUSEWATCH_STORE=supabase`. To change the travel limit, set the optional Actions variable `HOUSEWATCH_TRAVEL_BUDGET`.

3. Import the repository into Vercel with root directory **`jarvis`**. Set `HOUSEWATCH_STORE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `HOUSEWATCH_REVALIDATE_TOKEN` before the first build. Keep `SUPABASE_DB_URL` in GitHub for the cache-only deployment. To enable on-demand travel calculation on Vercel, add `SUPABASE_DB_URL` there as a server-only environment variable.
4. Dispatch the collector workflow once after setup. Verify that `/api/listings` reports `source: "live"` and a current `updatedAt`, then open `/listings`. An empty public view gives the mock feed until collection adds Delft ads.
