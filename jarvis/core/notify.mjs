import { createHmac } from 'node:crypto';
import { registerTsResolve } from './ts-hooks.mjs';

/**
 * Alerts after each collector run (GitHub Actions, so no Vercel CPU): for every enabled
 * alert_subscriptions row, find homes first seen since that channel's cursor that match the
 * person's synced search + filters, then send one short email digest (Resend, at most hourly)
 * and/or one web push per device. Failures are counted, never thrown: alerts must not break
 * collection.
 *
 * Matching uses the app's own code (lib/listings/match.ts + query.ts) on the same public feed the
 * site shows, so an alert never mentions a home the page would hide.
 */

const EMAIL_GAP_MS = 60 * 60 * 1000;
const MAX_IN_DIGEST = 8;
/** The site shows homes around the chosen campus; alerts stay within the same radius. */
export const ALERT_RADIUS_KM = 35;

const site = () => (process.env.HOUSEWATCH_SITE_URL || 'https://housewatch-one.vercel.app').replace(/\/$/, '');

let libPromise = null;
/** The app's matching modules, imported through the TypeScript resolve hooks. */
export function loadMatchingLib() {
  libPromise ??= (async () => {
    const hooks = registerTsResolve();
    try {
      const [match, query, scores, universities, defaults, sync] = await Promise.all([
        import('../lib/listings/match.ts'),
        import('../lib/listings/query.ts'),
        import('../lib/listings/scores.ts'),
        import('../lib/universities.ts'),
        import('../lib/listings/defaults.ts'),
        import('../lib/sync.ts'),
      ]);
      return {
        viewListing: match.viewListing,
        passesFilters: query.passesFilters,
        EMPTY_FILTERS: query.EMPTY_FILTERS,
        median: scores.median,
        universityById: universities.universityById,
        DEFAULT_SEARCH: defaults.DEFAULT_SEARCH,
        valueOf: sync.valueOf,
      };
    } finally {
      hooks.deregister();
    }
  })();
  return libPromise;
}

/** The public feed as the site renders it (Supabase public views → UI listings). */
export async function loadPublicFeed(nowIso) {
  const hooks = registerTsResolve();
  try {
    const feed = await import('../lib/server/supabase-feed.ts');
    const ui = await import('../lib/server/to-ui-listing.ts');
    const live = await feed.readSupabaseListings();
    if (live.source !== 'live') return [];
    const amenities = await feed.readSupabaseAmenities();
    return ui.toUiFeed(live, nowIso, () => amenities).listings;
  } finally {
    hooks.deregister();
  }
}

export const medianPerM2 = (lib, listings) =>
  lib.median(listings.map((l) => (l.costs.rent + (l.costs.serviceCosts ?? 0)) / Math.max(1, l.sizeM2)));

/** Homes first seen after `since` (ms) that match the synced search, best first. */
export function findMatches({ lib, listings, doc, since, nowIso, perM2 }) {
  const search = { ...lib.DEFAULT_SEARCH, ...(lib.valueOf(doc, 'search') ?? {}) };
  const filters = { ...lib.EMPTY_FILTERS, ...(lib.valueOf(doc, 'filters') ?? {}) };
  const hidden = new Set([...(lib.valueOf(doc, 'saved') ?? []), ...(lib.valueOf(doc, 'passed') ?? [])]);
  const university = lib.universityById(search.university);
  const views = [];
  for (const listing of listings) {
    if (!(Date.parse(listing.listedAt) > since) || hidden.has(listing.id)) continue;
    const view = lib.viewListing(listing, search, university, nowIso, perM2);
    if (view.status === 'outside' || view.travel.km > ALERT_RADIUS_KM || !lib.passesFilters(view, filters)) continue;
    views.push(view);
  }
  views.sort((a, b) => (a.status === 'match' ? 0 : 1) - (b.status === 'match' ? 0 : 1) || a.total - b.total);
  return { university, views };
}

/** HMAC of the key hash; Postgres alerts_unsubscribe() checks the same signature. */
export const unsubscribeSig = (secret, keyHash) => createHmac('sha256', secret).update(keyHash).digest('hex');
export const unsubscribeUrl = (secret, keyHash) =>
  `${site()}/api/alerts/unsubscribe?k=${keyHash}&t=${unsubscribeSig(secret, keyHash)}`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const euro = (n) => `€${Math.round(n).toLocaleString('en-GB')}`;
const homeUrl = (id) => `${site()}/listings?home=${encodeURIComponent(id)}`;
const line = (v) => {
  const l = v.listing;
  const place = [l.location?.neighbourhood, l.location?.street].filter(Boolean)[0] ?? '';
  // Many ads are titled with their street: don't say it twice.
  const where = place && !String(l.title).toLowerCase().includes(place.toLowerCase()) ? place : '';
  return { title: l.title, meta: [`${euro(v.total)}/month${v.totalComplete ? '' : '+'}`, `${l.sizeM2} m²`, where].filter(Boolean).join(' · '), url: homeUrl(l.id) };
};

/** Plain, monochrome digest: subject, HTML and text parts. */
export function digestEmail({ views, university, unsubscribe }) {
  const n = views.length;
  const shown = views.slice(0, MAX_IN_DIGEST).map(line);
  const place = university.short ?? university.name ?? 'your campus';
  const subject = `${n} new home${n === 1 ? '' : 's'} near ${place}`;
  const more = n > shown.length ? n - shown.length : 0;
  const all = `${site()}/listings`;
  const text = [
    subject,
    '',
    ...shown.flatMap((s) => [s.title, s.meta, s.url, '']),
    more ? `And ${more} more: ${all}` : `See all: ${all}`,
    '',
    `Stop these emails: ${unsubscribe}`,
  ].join('\n');
  const rows = shown
    .map(
      (s) => `<tr><td style="padding:14px 0;border-top:1px solid #ebebeb">
<a href="${escapeHtml(s.url)}" style="color:#222;text-decoration:none;font-weight:600;font-size:16px">${escapeHtml(s.title)}</a>
<div style="color:#6a6a6a;font-size:14px;margin-top:4px">${escapeHtml(s.meta)}</div></td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#fff">
<div style="max-width:520px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#222">
<p style="font-size:13px;color:#6a6a6a;margin:0 0 6px">Housewatch</p>
<h1 style="font-size:22px;letter-spacing:-0.02em;margin:0 0 18px">${escapeHtml(subject)}</h1>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>
<p style="margin:22px 0"><a href="${escapeHtml(all)}" style="display:inline-block;background:#222;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:12px">${more ? `See all ${n}` : 'Open Housewatch'}</a></p>
<p style="font-size:12px;color:#929292;margin-top:28px">You get this because you turned on alerts for this search. <a href="${escapeHtml(unsubscribe)}" style="color:#929292">Stop these emails</a>.</p>
</div></body></html>`;
  return { subject, html, text };
}

export function pushPayload({ views, university }) {
  const n = views.length;
  const first = line(views[0]);
  const place = university.short ?? 'your campus';
  return {
    title: `${n} new home${n === 1 ? '' : 's'} near ${place}`,
    body: n === 1 ? `${first.title} · ${first.meta}` : `${first.title} · ${first.meta}, and ${n - 1} more`,
    url: n === 1 ? `/listings?home=${encodeURIComponent(views[0].listing.id)}` : '/listings',
    tag: 'housewatch-new',
  };
}

async function resendSend({ to, subject, html, text, unsubscribe }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [to],
      subject,
      html,
      text,
      headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw Object.assign(new Error(`Resend answered ${res.status}`), { status: res.status });
}

let webpush = null;
async function webPushSend(subscription, payload) {
  if (!webpush) {
    webpush = (await import('web-push')).default;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:alerts@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
  await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'normal' });
}

export async function runNotifications(store, {
  sendEmail = resendSend,
  sendPush = webPushSend,
  loadFeed = loadPublicFeed,
  env = process.env,
} = {}) {
  const sql = store?.sql;
  if (!sql) return {};
  const emailReady = !!(env.RESEND_API_KEY && env.RESEND_FROM);
  const pushReady = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (!emailReady && !pushReady) return { alerts: 'not configured' };

  const subs = await sql`
    SELECT a.key_hash, a.push, a.push_cursor, a.email_cursor, a.last_email_at, s.data, u.email
    FROM public.alert_subscriptions a
    JOIN public.sync_states s ON s.key_hash = a.key_hash
    LEFT JOIN auth.users u ON u.id = a.user_id AND u.email_confirmed_at IS NOT NULL
    WHERE a.enabled`;
  const out = { alertsChecked: subs.length, emailsSent: 0, pushesSent: 0, alertErrors: 0 };
  if (!subs.length) return out;

  const [{ now }] = await sql`SELECT now() AS now`;
  const nowIso = new Date(now).toISOString();
  const listings = await loadFeed(nowIso);
  const lib = await loadMatchingLib();
  const perM2 = medianPerM2(lib, listings);
  const [{ secret }] = await sql`SELECT secret FROM public.alert_secret`;

  for (const sub of subs) {
    const doc = sub.data ?? {};
    if (pushReady && Array.isArray(sub.push) && sub.push.length) {
      const { views, university } = findMatches({ lib, listings, doc, since: +new Date(sub.push_cursor), nowIso, perM2 });
      const dead = [];
      if (views.length) {
        const payload = pushPayload({ views, university });
        for (const subscription of sub.push) {
          try {
            await sendPush(subscription, payload);
            out.pushesSent++;
          } catch (error) {
            if ([404, 410].includes(error?.statusCode)) dead.push(subscription.endpoint);
            else out.alertErrors++;
          }
        }
      }
      await sql`UPDATE public.alert_subscriptions SET push_cursor = ${now} WHERE key_hash = ${sub.key_hash}`;
      // Expired subscriptions (404/410: app removed, permission revoked) are dropped.
      for (const endpoint of dead) {
        await sql`UPDATE public.alert_subscriptions
          SET push = coalesce((SELECT jsonb_agg(s) FROM jsonb_array_elements(push) s WHERE s->>'endpoint' <> ${endpoint}), '[]'::jsonb)
          WHERE key_hash = ${sub.key_hash}`;
      }
      if (dead.length) {
        await sql`UPDATE public.alert_subscriptions SET enabled = false
          WHERE key_hash = ${sub.key_hash} AND jsonb_array_length(push) = 0 AND user_id IS NULL`;
      }
    }
    const emailDue = !sub.last_email_at || +new Date(now) - +new Date(sub.last_email_at) >= EMAIL_GAP_MS;
    if (emailReady && sub.email && emailDue) {
      const { views, university } = findMatches({ lib, listings, doc, since: +new Date(sub.email_cursor), nowIso, perM2 });
      if (!views.length) {
        await sql`UPDATE public.alert_subscriptions SET email_cursor = ${now} WHERE key_hash = ${sub.key_hash}`;
        continue;
      }
      const unsubscribe = unsubscribeUrl(secret, sub.key_hash);
      try {
        await sendEmail({ to: sub.email, unsubscribe, ...digestEmail({ views, university, unsubscribe }) });
        out.emailsSent++;
        await sql`UPDATE public.alert_subscriptions SET email_cursor = ${now}, last_email_at = ${now} WHERE key_hash = ${sub.key_hash}`;
      } catch {
        out.alertErrors++; // cursor stays: the same homes go out next time
      }
    }
  }
  return out;
}
