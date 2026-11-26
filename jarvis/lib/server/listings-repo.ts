import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { databasePath } from "../../core/runtime.mjs";
import { storeKind } from "../../core/open-store.mjs";
import { readListings, type ListingsResult } from "./listings-data.ts";
import { readUiAmenities, toUiFeed, type UiFeed } from "./to-ui-listing.ts";
import { hasSupabaseListings, readSupabaseAmenities, readSupabaseListings, type Bounds } from "./supabase-feed.ts";
import {
  DEFAULT_UNIVERSITY, REGION_RADIUS_KM, STUDENT_CITIES, studentCityById, universityById, type StudentCityId,
} from "../universities.ts";

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

export interface RegionPage extends LivePage {
  /** The student city whose surroundings this page covers. */
  region: StudentCityId;
}

/** The box the site loads for a region: REGION_RADIUS_KM around the student city's centre. */
export function regionBounds(region: StudentCityId, radiusKm = REGION_RADIUS_KM): Bounds {
  const city = studentCityById(region) ?? studentCityById(DEFAULT_REGION)!;
  const dLat = radiusKm / 111.2;
  const dLng = radiusKm / (111.2 * Math.cos((city.lat * Math.PI) / 180));
  return { south: city.lat - dLat, north: city.lat + dLat, west: city.lng - dLng, east: city.lng + dLng };
}

export const DEFAULT_REGION: StudentCityId = universityById(DEFAULT_UNIVERSITY).region;

/** A known region id, else the default one (ids arrive from URLs). */
export function regionId(value: string | null | undefined): StudentCityId {
  return (STUDENT_CITIES.find((city) => city.id === value)?.id ?? DEFAULT_REGION) as StudentCityId;
}

const inBounds = (bounds: Bounds, lat: number | null, lng: number | null) =>
  lat !== null && lng !== null && lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east;

/**
 * The homes around one student city, ready for the UI. Cached per region and refreshed by the
 * collector through the `listings` tag, so Vercel only does work on a cache miss. "now" is stamped
 * inside the cache scope (Cache Components forbid an uncached clock). In Supabase mode the demo
 * homes are never shown: an empty database means "collecting", an empty region is just empty.
 */
export async function getRegionPage(region: StudentCityId): Promise<RegionPage> {
  "use cache";
  cacheTag("listings", `listings:${region}`);
  const live = storeKind() === "supabase";
  if (live) cacheLife("hours");
  else cacheLife({ stale: 300, revalidate: 300, expire: 3600 });
  const now = new Date().toISOString();
  const bounds = regionBounds(region);
  if (live) {
    const feed = await readSupabaseListings(bounds);
    // Amenities slightly beyond the box, so homes on its edge still find their nearest shop.
    const amenities = feed.listings.length ? await readSupabaseAmenities(regionBounds(region, REGION_RADIUS_KM + 5)) : [];
    const ui = toUiFeed(feed, now, () => amenities);
    const collecting = ui.listings.length === 0 && !(await hasSupabaseListings());
    return { region, listings: ui.listings, now, updatedAt: ui.updatedAt, collecting };
  }
  const feed = await getUiFeed(now);
  const listings = feed.listings.filter((listing) => inBounds(bounds, listing.location.lat, listing.location.lng));
  return { region, listings, now, updatedAt: feed.updatedAt, collecting: listings.length === 0 && feed.listings.length === 0 };
}

/** The default page (TU Delft's region). Kept for callers that predate regions. */
export async function getLivePage(): Promise<LivePage> {
  return getRegionPage(DEFAULT_REGION);
}
