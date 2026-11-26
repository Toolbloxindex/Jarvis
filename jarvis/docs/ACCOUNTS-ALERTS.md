# Optional email accounts, alerts and web push

Everything here is optional. Without an email, the account-free sync key (docs/SYNC-PLAN.md) works as before.

## Email sign-in (Supabase Auth)

- Devices panel → **Email**: one form, an email and an optional password.
  - With a password: sign in, or create the account (Supabase sends a confirmation link).
  - Without a password: Supabase emails a sign-in link (implicit flow, so the link works on any device).
  - Wrong password on an existing account shows "Wrong password" and a **Forgot password?** link (reset email → the site opens a "New password" view).
- After sign-in, `account_link(key)` (migration 0006) stores this device's sync key on the account if it has none, else returns the account's key and the device **adopts** it (`adoptKey` in lib/sync.ts merges the device's list in, same as pairing).
- **Sign out** keeps the list and the sync key on the device. **Set a password** is available after a link sign-in.
- supabase-js (`lib/account.ts`) loads only when a session exists, an auth link is in the URL, or the email view opens.

## Alerts (header bell on tablets/desktops; Devices → Alerts on phones)

- Settings per sync key in `alert_subscriptions` (only via SECURITY DEFINER RPCs: `alerts_get`, `alerts_set`, `alerts_push_add`, `alerts_push_remove`, `alerts_unsubscribe`).
- **Email** needs a signed-in, confirmed email. Digest at most hourly.
- **Notifications on this device**: web push via `public/sw.js`. iPhone/iPad need the site added to the Home Screen first (iOS 16.4+); the panel says so in Safari tabs.
- The collector (`core/notify.mjs`, GitHub Actions, no Vercel CPU) runs after any run that added or located homes. It uses the same public feed and the same matching code as the site: the person's synced search and filters, saved/passed homes excluded, within 35 km of the campus, homes first seen after each channel's cursor.
- Unsubscribe links: `/api/alerts/unsubscribe?k=<key hash>&t=<HMAC>`. GET shows a confirm button (mail scanners prefetch links), POST unsubscribes (also the one-click `List-Unsubscribe-Post` header). The HMAC secret stays in Postgres (`alert_secret`).

## Configuration

| Where | Name | Value |
| --- | --- | --- |
| GitHub secrets | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY` | same as Vercel (public values; the collector reads the public feed) |
| GitHub secrets | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | from `jarvis/.env` (`VAPID_SUBJECT` = `mailto:` an address you read) |
| GitHub secrets | `RESEND_API_KEY`, `RESEND_FROM` | Resend API key; `Housewatch <alerts@your-verified-domain>` |
| Vercel env | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | same as `VAPID_PUBLIC_KEY` (needed at build time) |
| Supabase Auth | SMTP | `node scripts/configure-auth-email.mjs` (Resend, see the script header) |

Without Resend, email alerts are skipped and Supabase's own mailer reaches only team members (2 emails/hour). **Resend needs a verified domain** to send to anyone but the Resend account owner; a `vercel.app` address cannot be verified. Push needs only the VAPID keys.

Auth URLs (already set): site URL `https://housewatch-one.vercel.app/listings`; redirect allow-list `https://housewatch-one.vercel.app/**`, `http://localhost:3100/**`, `http://localhost:3400/**`.
