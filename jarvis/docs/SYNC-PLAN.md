# Account-free users and cross-device sync

Status: **shipped** (local-first state, sync between devices, pairing). Optional email recovery is not built.

## How it works

1. **Local first.** `lib/persist.ts` keeps all personal state in `localStorage` (`hw:v1:*`): `saved`, `passed`, `notes`, `checked`, `search`, `filters`, `sort`, plus device-only layout (`mapOn`, `filtersDocked`). Reloads and other tabs see it immediately; nothing waits on the network.
2. **Identity without accounts.** Each browser makes a random 192-bit **sync key** (`hw:sync:key`). It is also stored in a first-party cookie `hw_sync` set by `/api/sync-key` (server-set, 400 days), because Safari wipes script-written storage and cookies after 7 days without a visit.
3. **Sync.** `lib/sync.ts` keeps a timestamped document of the synced fields and talks to Supabase **directly from the browser** (no Vercel CPU):
   - `sync_pull(key)` on load, on focus/return to the tab (at most every 10 s) and every 60 s while visible;
   - `sync_push(key, doc, baseVersion)` 1.5 s after the last edit, and immediately when the tab is hidden; compare-and-set: on a conflict the client merges and retries.
   - Merge: sets merge per home (latest add/remove wins, removals kept 90 days as tombstones); notes/checklists per home; search/filters/sort latest-wins. Merging is order-independent, so devices always converge. Tests: `tests/sync-merge.test.mjs`.
4. **Pairing.** "Devices" in the header shows a QR code and a 6-character code (`sync_pair_create`, 10 minutes, single use, no 0/O/1/I/L). The other device scans (opens `/listings#pair=CODE`) or types the code; `sync_pair_claim` hands over the key, and that device's own list is merged in. "Stop syncing this device" moves it to a fresh key and keeps a private copy.

## Security

- Tables `sync_states`, `sync_pair_codes`, `sync_pair_failures` have RLS on and no grants: the public API cannot read them. Browsers use only the four `SECURITY DEFINER` functions (`supabase/migrations/0004_sync.sql`).
- Only the SHA-256 of a key is stored. The raw key exists in the database only inside an unclaimed pairing code (max 10 minutes).
- Brute force on codes: 31^6 ≈ 887 million codes, each live 10 minutes; all claims are refused after 200 failures in 10 minutes.
- Documents are capped at 256 KB.
- The sync key is a bearer secret: anyone who has it sees that list. It never leaves the browser except to Supabase and the cookie route.

## Free-tier cost

| Resource | Use | Limit |
| --- | --- | --- |
| Supabase DB | ~2–10 KB per browser | 500 MB |
| Supabase egress | ~1 small pull/min per open tab + pushes on edits | 5 GB |
| Supabase auth | not used | — |
| Vercel CPU | one tiny `/api/sync-key` call per device | 4 h |

## Later (optional)

- Email recovery: store an email hash next to the key and send a one-time link that returns the key, for people who lose every device.
- Realtime instead of polling, if lists ever need second-by-second updates.
