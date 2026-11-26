# Account-free users and cross-device sync

Status: **step 1 shipped** (local-first state + device cookie). Steps 2–4 are planned, in priority order.

## Goals

- No sign-up, no email, no password. Opening the site is enough.
- Your saved and passed homes, notes, checklists and search follow you to your phone.
- Stay well inside the free tiers: Supabase Free (500 MB DB, 50k monthly active auth users, 2 GB egress) and Vercel Hobby (4 h Active CPU).

## 1. Local-first state ✅ (shipped)

`lib/persist.ts` keeps every piece of personal state in `localStorage` (`hw:v1:*` keys: `search`, `filters`, `sort`, `saved`, `passed`, `notes`, `checked`, `mapOn`, `filtersDocked`), synced across tabs, rendered without hydration mismatches. An `hw_device` cookie (random UUID, 2 years, `SameSite=Lax; Secure`) identifies the browser.

Cost: zero server work.

## 2. Anonymous Supabase user per browser (next)

- Enable **Anonymous sign-ins** in Supabase Auth (Dashboard → Authentication → Sign In / Providers, or `auth.enable_anonymous_sign_ins = true` in `supabase/config.toml` + `supabase config push`). Turn on the built-in CAPTCHA/rate limit for anonymous sign-ins to stop abuse.
- On first visit the browser calls `supabase.auth.signInAnonymously()`; supabase-js keeps the session (refresh token) in storage. The `hw_device` cookie becomes a label only.
- One table, row-level secured:

```sql
create table public.user_state (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}',   -- { saved:[], passed:[], notes:{}, checked:{}, search:{}, filters:{}, ... }
  version bigint not null default 0,  -- bumped on every write, for conflict detection
  updated_at timestamptz not null default now()
);
alter table public.user_state enable row level security;
create policy "own state" on public.user_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- Writes go **browser → Supabase directly** (supabase-js + RLS), never through Vercel functions, so they cost no Vercel CPU.
- Debounce writes (2 s after the last change, plus `visibilitychange: hidden` flush). A heavy triage session is a handful of writes per minute.
- Merge rule per field: sets (`saved`, `passed`) merge as union with tombstones (`{id, at, removed}`); scalars (`search`, `filters`, notes per home) are last-writer-wins by timestamp.

Size: ~2–10 KB per user. 10,000 users ≈ 100 MB, well inside 500 MB.

## 3. Pairing another device (the "clever" part)

No accounts, so devices are linked by handing over the anonymous identity:

1. On device A, "Use on another device" shows a **QR code + 6-character code** (e.g. `K7P-2QX`), valid for 10 minutes, single use.
2. Device B scans the QR (opens `/pair#code`) or types the code.
3. A Supabase Edge Function `claim-pairing` (service role) checks the code, expiry and attempt count. It gives A's user a synthetic, never-mailed address (`<user-id>@pair.invalid`, `email_confirm: true`) via `auth.admin.updateUserById` on first pairing, then calls `auth.admin.generateLink({ type: 'magiclink' })` and returns only the `hashed_token`. Device B calls `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` and is signed in as the same user. No email is ever sent.
4. Both devices now share `user_state`; Realtime (or a refetch on focus) keeps them in step.

```sql
create table public.pairing_codes (
  code text primary key,              -- 6 chars, no ambiguous letters
  user_id uuid not null references auth.users on delete cascade,
  expires_at timestamptz not null,
  attempts int not null default 0
);
```

Protection: codes expire in 10 min, are single use, and lock after 5 wrong attempts per IP/device. The QR carries the code in the URL fragment so it never reaches server logs.

Unlink: "Sign out on this device" just drops the local session; "Reset everywhere" deletes the anonymous user (cascade deletes the state).

## 4. Optional recovery (later)

If someone loses every device, their anonymous user is gone. Offer an optional "Add email to keep your list" that calls `supabase.auth.updateUser({ email })`, converting the anonymous user into a permanent one with the same id. No data migration needed.

## Free-tier budget

| Resource | Use | Limit |
| --- | --- | --- |
| Supabase auth MAU | 1 per browser that visits | 50,000 |
| Supabase DB | ~5 KB/user | 500 MB |
| Supabase egress | state fetch on load (~5 KB) + writes | 2 GB / 5 GB cached |
| Realtime | optional, 1 channel per open tab | 200 concurrent |
| Vercel CPU | **none**: sync bypasses Vercel | 4 h |

## Order of work

1. ✅ Local-first persistence + device cookie.
2. Anonymous auth + `user_state` + debounced sync + merge (≈ half a day).
3. Pairing via QR / 6-char code (≈ half a day, needs one Edge Function).
4. Optional email upgrade.
