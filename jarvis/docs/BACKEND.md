# Housewatch backend

SQLite is the default for development. The app uses the existing mock listings when the selected store has no Delft property ads. In Supabase mode the app reads curated data through the `public_listings`, `public_amenities`, and `public_feed_status` views using the server-side anon client. The worker writes through the Postgres transaction pooler. The migration keeps raw listings, settings, and manual travel origins private.

## Configuration

| Environment variable | Used by |
| --- | --- |
| `HOUSEWATCH_STORE` | App and CLI. Defaults to `sqlite`. Set `supabase` to use Postgres and the public Supabase views. |
| `HOUSEWATCH_DB` | SQLite file. Defaults to `./data/housing.sqlite`. Use a dedicated directory because SQLite initialization sets private permissions. |
| `SUPABASE_DB_URL` | Collector and prune job. Use the Supabase transaction pooler URL on port 6543 with the database password. Also grants the app permission to calculate travel on demand if set on Vercel. |
| `NEXT_PUBLIC_SUPABASE_URL` | App. The Supabase project's HTTPS URL. |
| `SUPABASE_ANON_KEY` | App. The project's anon key used in the server-only client. |
| `HOUSEWATCH_REVALIDATE_URL` | Collector. Full URL of the app's `/api/revalidate` route. |
| `HOUSEWATCH_REVALIDATE_TOKEN` | Collector and app. Use the same secret on both. |
| `HOUSEWATCH_TRAVEL_BUDGET` | Collector. Defaults to 10 listings per run. Set to 0 to defer all automated travel. |
| `HOUSEWATCH_MOTIS_URL` | Optional local loopback timetable planner. Transit needs a valid cached sample. |
| `HOUSEWATCH_AMENITIES_FILE` | Optional local amenities catalogue JSON for travel and the SQLite feed. |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | Collector. Optional. Turn on AI-assisted extraction for free-text ads. Budgets, other providers, and privacy rules are in [AI extraction](AI-EXTRACTION.md). |

## Local commands

Run from `jarvis/` with Node 22.16 or later. CI runs Node 24.

```sh
npm ci
npm run dev
npm run test:core
npm run verify:sources
npm run collect
npm run travel -- <listingId>
```

`collect` checks real sources that are due, records run timestamps and counts, and calculates travel for new or moved listings within its budget. Excess work stays queued for later passes. `travel` calculates for one existing listing. Both commands can contact routing providers. The tests use fixture databases and mocked responses.

`verify:sources` checks public rental pages, applies robots rules and source backoff, and stops a source on HTTP 403 or 429. Pass `-- --source=<id>` to check one source. Raw responses and reports are private local files under gitignored `data/verify/`. The verifier leaves the listings database read-only.

Production uses the `days` cache profile with the `listings` tag. After a changed pass, the collector posts to `/api/revalidate` with a bearer token and a five-second timeout. The endpoint expires the tag and the next request refreshes the feed. SQLite keeps its five-minute time-based refresh. `updatedAt` reflects the latest finished run in the cached feed. Legacy local listings can fall back to their last observed timestamp.

`GET /api/listings/<id>/travel` returns cached travel. `POST` returns recent cached travel or attempts a calculation under a 24-hour per-listing cooldown in writable mode. Supabase deployments with read credentials alone serve cached results for both methods. The daily prune job retains 12 months of price and availability history, collector runs, and events, plus the latest completed run.

Campus destinations come from `lib/universities.ts`. An OSRM table request per mode covers all campuses, the nearby amenities, and, when needed, station access. The worker caches the results in the existing SQLite and Supabase travel payloads. Previously cached Aula-only rows keep their legacy result until the listing moves or its travel is recalculated.

MOTIS provides a weekday morning transit sample when configured. Otherwise the rail estimate adds station access (with a small bike parking allowance), typical train time, half the off-peak headway, and the last mile. Erasmus also considers metro plus walking. The fallback reports whole-minute estimates and leaves Delft-local transit blank. Rail inputs and sources are in `core/university-travel.mjs`.

Routing data uses OpenStreetMap and the FOSSGIS routing service. [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) · [Fix the map](https://www.openstreetmap.org/fixthemap) · [FOSSGIS routing usage policy](https://routing.openstreetmap.de/about.html)

Setup for the database, Actions, and Vercel is in [Deployment plan](DEPLOYMENT-PLAN.md#what-needs-your-access).
