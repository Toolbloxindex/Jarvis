# Housewatch backend

`core/` contains the headless public collector, matcher, SQLite store, and travel engine. The Next.js server adapter reads Delft property ads from SQLite, groups the store's linked duplicates, and maps advertised terms, evidence flags, and cached travel. The feed uses the existing mock listings when the database is missing, empty, or holds no Delft property ads. `updatedAt` is the latest stored change or source sighting in the live feed. The Facebook compatibility module leaves offers unchanged and supplies an empty duplicate key because the original Facebook module was missing.

The collector installs the price and availability history trigger when it opens the store. New changes are captured atomically with the listing update. For older databases, history starts with the recorded first sighting and linked duplicate sightings, then adds any changes captured after initialization.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `HOUSEWATCH_DB` | SQLite file for the app and both CLIs. Defaults to `./data/housing.sqlite`. Use a dedicated directory because the collector sets private permissions on it. Share the same database between Next.js and the collector. |
| `HOUSEWATCH_MOTIS_URL` | Optional loopback HTTP address of the MOTIS timetable planner. Transit minutes require a cached, still-valid timetable sample. |
| `HOUSEWATCH_AMENITIES_FILE` | Optional path to the local amenities JSON catalogue. |
| `HOUSEWATCH_REVALIDATE_TOKEN` | Enables the bearer-token protected `POST /api/revalidate`. |

Node 22.16 runs `node:sqlite` directly and emits the experimental SQLite warning. The travel CLI and tests also enable native TypeScript stripping. Next.js uses the Node runtime and enforces the server-only import boundary. The existing Next.js configuration supports the backend.

## Running it

```sh
npm run collect
npm run travel -- <listingId>
npm run test:core
```

`collect` runs one public discovery pass, honors per-source scheduling, and prints `checked`, `added`, and `changed`. Run one collector at a time per database. `travel` uses the requested listing and writes its route cache. Both commands use environment variables exported in the shell. The tests use temporary databases and fixture responses.

`GET /api/listings` and the page adapter share the `listings` cache tag. After five minutes, the next request can receive the previous feed while Next.js refreshes it. The entry expires after one hour. For immediate expiration after collection, send `POST /api/revalidate` with `Authorization: Bearer <token>` and request the feed again. Collection leaves cache invalidation to the app or the operator.

`GET /api/listings/<id>/travel` reads cached walk, bike, and transit minutes for the Aula and cached amenities. `POST` calculates or refreshes that one listing on open. Missing times are null. `provider_unavailable` can include partial results, and `location_unresolved` indicates a lookup without a matching address. The corresponding mock endpoint response uses the existing mock transit value while the feed is in mock mode.

## Listings page

`/listings` awaits `getUiFeed(MOCK_NOW)` in `app/listings/page.tsx`. To switch to a real clock, derive one timestamp there and pass it to both the feed and the experience. Derive it within a cache scope to keep the page prerenderable.

The page feed omits ads that lack coordinates, rent, photos, or either amenity. `getUiFeed` reports the counts in `skipped` as `noCoordinates`, `noRent`, `noPhotos`, and `awaitingTravelData`. A listing can count toward several reasons. If every live ad is skipped, the page receives an empty live feed. Missing amenities are filled from the local catalogue or the shared travel cache using straight-line distance.

Review flags identify the advertised rent quote, the placeholder move-in date, furnishing, and other unconfirmed details. Unknown floor area uses the same-kind live median, with the same-kind mock median when no live measurement is available.
