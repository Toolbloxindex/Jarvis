import { runPublicDiscovery } from './discovery.mjs';
import { createTravelService, listingTravelKey } from './travel.mjs';
import { runAiPass } from './ai-collect.mjs';
import { runNotifications } from './notify.mjs';

const queueKey = 'collector.travel.pending';

// Homes located per run. Geocoding (PDOK) takes well under a second per home; routing is batched
// (one OSRM table per mode for 12 homes, ~9 s each on the public server) and stops at a deadline.
export function travelBudget(value = process.env.HOUSEWATCH_TRAVEL_BUDGET ?? '60') {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('HOUSEWATCH_TRAVEL_BUDGET must be a nonnegative integer.');
  }
  return Number(value);
}

/** Routing time per run (HOUSEWATCH_ROUTING_SECONDS, default 180): keeps a run under its 12-minute cap. */
export function routingMs(value = process.env.HOUSEWATCH_ROUTING_SECONDS ?? '180') {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 180_000;
}

async function notifyRevalidation(fetcher, url, token) {
  if (!url || !token) return null;
  try {
    const response = await fetcher(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function runCollector(store, {
  discover = runPublicDiscovery,
  makeTravel = createTravelService,
  fetcher = fetch,
  budget = travelBudget,
  aiPass = runAiPass,
  notify = runNotifications,
  revalidateUrl = process.env.HOUSEWATCH_REVALIDATE_URL,
  revalidateToken = process.env.HOUSEWATCH_REVALIDATE_TOKEN,
} = {}) {
  const id = await store.startCollectorRun();
  const counts = { checked: 0, added: 0, changed: 0 };
  let travelChecked = 0;
  let travelUpdated = 0;
  let travelFailed = 0;
  let travelDeferred = 0;
  let ai = {};
  try {
    const limit = budget();
    const result = await discover(store);
    Object.assign(counts, { checked: result.checked, added: result.added, changed: result.changed });
    // Retain work across runs so a busy collection pass does not strand new ads.
    const pending = [...new Set([...(await store.getConfig(queueKey, [])), ...result.travelIds])];
    if (result.travelIds.length) await store.setConfig(queueKey, pending);
    const travel = makeTravel(store);
    const remaining = [];
    if (travel.checkMany) {
      // Batched: locate every home in this run's share, route them in shared OSRM tables, and stop
      // routing at the deadline (located homes still show; they are routed in a later run).
      const take = [];
      for (const listingId of pending) {
        if (take.length >= limit) { remaining.push(listingId); continue; }
        const listing = await store.getListing(listingId);
        if (!listing || !listing.city?.trim() || listing.availability === 'unavailable' ||
            listing.listing_kind === 'general_lead' || !listingTravelKey(listing)) continue;
        take.push(listing);
      }
      const outcome = await travel.checkMany(take, { deadline: Date.now() + routingMs() });
      for (const listing of take) {
        const state = outcome.get(listing.id) ?? 'deferred';
        if (state === 'skipped' || state === 'fresh') continue;
        travelChecked++;
        if (state === 'updated') travelUpdated++;
        else if (state === 'deferred') { travelDeferred++; remaining.push(listing.id); }
        else { travelFailed++; if (state !== 'failed:422') remaining.push(listing.id); }
      }
    } else for (const listingId of pending) {
      if (travelChecked >= limit) {
        remaining.push(listingId);
        continue;
      }
      const listing = await store.getListing(listingId);
      if (!listing || !listing.city?.trim() || listing.availability === 'unavailable' ||
          listing.listing_kind === 'general_lead' || !listingTravelKey(listing)) continue;
      const before = await travel.display(listing);
      travelChecked++;
      try {
        const after = await travel.check(listing, {});
        if (after.checkedAt && after.checkedAt !== before.checkedAt) travelUpdated++;
      } catch (error) {
        if (![409, 422, 429, 503].includes(error?.status)) throw error;
        travelFailed++;
        if (error.status !== 422) remaining.push(listingId);
      }
    }
    if (pending.length) await store.setConfig(queueKey, remaining);
    // Enrichment only: the pass logs and swallows its own failures.
    ai = await aiPass(store, result.aiIds ?? []);
    await store.finishCollectorRun(id, counts);
  } catch (error) {
    await store.finishCollectorRun(id, { ...counts, error: 'Collection interrupted.' });
    throw error;
  }
  const revalidated = counts.added || counts.changed || travelUpdated || ai.aiUpdated
    ? await notifyRevalidation(fetcher, revalidateUrl, revalidateToken)
    : null;
  // New-home alerts (email digest + web push). Never fails the collection.
  let alerts = {};
  if (counts.added || travelUpdated) {
    try {
      alerts = await notify(store);
    } catch (error) {
      alerts = { alertErrors: 1 };
      console.error('Alerts failed:', String(error?.message ?? error).slice(0, 200));
    }
  }
  return { ...counts, travelChecked, travelUpdated, travelFailed, travelDeferred, ...ai, revalidated, ...alerts };
}
