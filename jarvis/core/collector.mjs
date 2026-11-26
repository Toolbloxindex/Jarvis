import { runPublicDiscovery } from './discovery.mjs';
import { createTravelService, listingTravelKey } from './travel.mjs';

const queueKey = 'collector.travel.pending';

export function travelBudget(value = process.env.HOUSEWATCH_TRAVEL_BUDGET ?? '10') {
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
  revalidateUrl = process.env.HOUSEWATCH_REVALIDATE_URL,
  revalidateToken = process.env.HOUSEWATCH_REVALIDATE_TOKEN,
} = {}) {
  const id = await store.startCollectorRun();
  const counts = { checked: 0, added: 0, changed: 0 };
  let travelChecked = 0;
  let travelUpdated = 0;
  let travelFailed = 0;
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
      if (!listing || listing.city?.toLowerCase() !== 'delft' || listing.availability === 'unavailable' ||
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
    await store.finishCollectorRun(id, counts);
  } catch (error) {
    await store.finishCollectorRun(id, { ...counts, error: 'Collection interrupted.' });
    throw error;
  }
  const revalidated = counts.added || counts.changed || travelUpdated
    ? await notifyRevalidation(fetcher, revalidateUrl, revalidateToken)
    : null;
  return { ...counts, travelChecked, travelUpdated, travelFailed, revalidated };
}
