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
