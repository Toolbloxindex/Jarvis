import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { databasePath } from "../../core/runtime.mjs";
import { readListings, type ListingsResult } from "./listings-data.ts";
import { readUiAmenities, toUiFeed, type UiFeed } from "./to-ui-listing.ts";

const listingsCacheLife = { stale: 300, revalidate: 300, expire: 3600 };

export type { LiveListing, ListingsResult } from "./listings-data.ts";

export async function getListings(): Promise<ListingsResult> {
  "use cache";
  cacheLife(listingsCacheLife);
  cacheTag("listings");
  return readListings(databasePath());
}

export async function getUiFeed(now: string): Promise<UiFeed> {
  "use cache";
  cacheLife(listingsCacheLife);
  cacheTag("listings");
  return toUiFeed(await getListings(), now, () => readUiAmenities(databasePath()));
}
