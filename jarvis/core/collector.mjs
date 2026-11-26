import { runPublicDiscovery } from './discovery.mjs';
import { createTravelService, listingTravelKey } from './travel.mjs';
import { runAiPass } from './ai-collect.mjs';

const queueKey = 'collector.travel.pending';

// Homes located and routed per run. Geocoding (PDOK) is quick; OSRM is paced at 2 s and capped
// daily (HOUSEWATCH_OSRM_DAILY), so 40 keeps a run well under its time limit.
export function travelBudget(value = process.env.HOUSEWATCH_TRAVEL_BUDGET ?? '40') {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('HOUSEWATCH_TRAVEL_BUDGET must be a nonnegative integer.');
  }
  return Number(value);
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
  revalidateUrl = process.env.HOUSEWATCH_REVALIDATE_URL,
  revalidateToken = process.env.HOUSEWATCH_REVALIDATE_TOKEN,
} = {}) {
  const id = await store.startCollectorRun();
  const counts = { checked: 0, added: 0, changed: 0 };
  let travelChecked = 0;
  let travelUpdated = 0;
  let travelFailed = 0;
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
    for (const listingId of pending) {
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
  return { ...counts, travelChecked, travelUpdated, travelFailed, ...ai, revalidated };
}
