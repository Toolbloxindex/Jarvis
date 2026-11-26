import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { databasePath } from "../../core/runtime.mjs";
import { storeKind } from "../../core/open-store.mjs";
import { readListings, type ListingsResult } from "./listings-data.ts";
import { readUiAmenities, toUiFeed, type UiFeed } from "./to-ui-listing.ts";
import { readSupabaseAmenities, readSupabaseListings } from "./supabase-feed.ts";

export type { LiveListing, ListingsResult } from "./listings-data.ts";

export async function getListings(): Promise<ListingsResult> {
  "use cache";
  cacheTag("listings");
  if (storeKind() === "supabase") {
    cacheLife("days");
    return readSupabaseListings();
  }
  cacheLife({ stale: 300, revalidate: 300, expire: 3600 });
  return readListings(databasePath());
}

export async function getUiFeed(now: string): Promise<UiFeed> {
  "use cache";
  cacheTag("listings");
  if (storeKind() === "supabase") {
    cacheLife("days");
    const feed = await getListings();
    const amenities = feed.source === "live" && feed.listings.some((listing) =>
      listing.location.lat !== null && listing.location.lng !== null && (!listing.nearestGym || !listing.nearestSupermarket))
      ? await readSupabaseAmenities() : [];
    return toUiFeed(feed, now, () => amenities);
  }
  cacheLife({ stale: 300, revalidate: 300, expire: 3600 });
  return toUiFeed(await getListings(), now, () => readUiAmenities(databasePath()));
}

export interface LivePage {
  listings: UiFeed["listings"];
  /** When this feed snapshot was rendered; the UI's "today". */
  now: string;
  /** Latest collector change, or null before the first collection. */
  updatedAt: string | null;
  /** True while there is no real data yet (production never shows mock homes). */
  collecting: boolean;
}

/**
 * The production feed. The snapshot is cached and refreshed on demand after each collector run,
 * so "now" is stamped inside the cache scope (Cache Components forbid an uncached clock). In
 * Supabase mode the mock homes are never shown: an empty database means "collecting".
 */
export async function getLivePage(): Promise<LivePage> {
  "use cache";
  cacheTag("listings");
  const live = storeKind() === "supabase";
  if (live) cacheLife("hours");
  else cacheLife({ stale: 300, revalidate: 300, expire: 3600 });
  const now = new Date().toISOString();
  const feed = await getUiFeed(now);
  if (live && feed.source !== "live") {
    return { listings: [], now, updatedAt: feed.updatedAt, collecting: true };
  }
  return { listings: feed.listings, now, updatedAt: feed.updatedAt, collecting: feed.listings.length === 0 };
}
