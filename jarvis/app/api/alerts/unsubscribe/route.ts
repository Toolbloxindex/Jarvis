/**
 * Unsubscribe from alert emails. The link carries the key hash and its HMAC; the check happens in
 * Postgres (alerts_unsubscribe), so no secret lives on Vercel.
 * GET shows a confirm button (mail scanners prefetch links; a GET must not unsubscribe).
 * POST unsubscribes: the button, and the one-click List-Unsubscribe-Post header of mail clients.
 */

const HEX64 = /^[0-9a-f]{64}$/;

function page(title: string, body: string, form?: { k: string; t: string }) {
  const button = form
    ? `<form method="post" action="/api/alerts/unsubscribe?k=${form.k}&t=${form.t}">
<button style="margin-top:20px;background:#222;color:#fff;border:0;border-radius:12px;padding:12px 18px;font:600 15px system-ui;cursor:pointer">Stop alert emails</button></form>`
    : `<p><a href="/listings" style="color:#222">Back to Housewatch</a></p>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · Housewatch</title></head><body style="margin:0;font-family:system-ui,-apple-system,sans-serif;color:#222">
<main style="max-width:420px;margin:18vh auto 0;padding:0 24px"><h1 style="font-size:24px;letter-spacing:-0.02em">${title}</h1>
<p style="color:#6a6a6a;line-height:1.5">${body}</p>${button}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function params(request: Request) {
  const url = new URL(request.url);
  const k = url.searchParams.get("k") ?? "";
  const t = url.searchParams.get("t") ?? "";
  return HEX64.test(k) && HEX64.test(t) ? { k, t } : null;
}

export async function GET(request: Request) {
  const p = params(request);
  if (!p) return page("Link not valid", "This unsubscribe link is incomplete. Open Alerts in Housewatch to change them.");
  return page("Stop alert emails?", "You won't get emails about new homes for this search. Notifications on your devices stay on.", p);
}

export async function POST(request: Request) {
  const p = params(request);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!p || !url || !anonKey) return page("Link not valid", "Open Alerts in Housewatch to change them.");
  const res = await fetch(`${url}/rest/v1/rpc/alerts_unsubscribe`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ p_key_hash: p.k, p_sig: p.t }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  const ok = res?.ok && (await res.json().catch(() => false)) === true;
  return ok
    ? page("Unsubscribed", "No more alert emails for this search. You can turn them back on under Alerts.")
    : page("Link not valid", "This link didn't work. Open Alerts in Housewatch to change them.");
}
