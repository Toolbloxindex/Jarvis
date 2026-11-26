import "server-only";
import { readFileSync } from "node:fs";
import { openExistingStore } from "../../core/runtime.mjs";
import { catalogPlaces, nearest } from "../../core/travel.mjs";
import { listings as mockListings } from "../listings/data.ts";
import type { FlagField, Listing, ListingKind, NearbyPlace } from "../listings/types";
import type { LiveListing, ListingsResult } from "./listings-data";

export type CatalogPlace = Omit<NearbyPlace, "lng"> & { lon: number };
type SizeMedians = Partial<Record<ListingKind, number>>;
type SkipReason = "noCoordinates" | "noRent" | "awaitingTravelData" | "noPhotos";
type ConversionOptions = {
  sizes?: SizeMedians;
  amenities?: () => CatalogPlace[];
  onSkip?: (reasons: SkipReason[]) => void;
};

export type UiFeed = {
  listings: Listing[];
  source: "live" | "mock";
  updatedAt: string | null;
  skipped: Record<string, number>;
};

function coordinate(value: number | null, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

function kindOf(listing: Pick<LiveListing, "kind" | "title" | "description" | "features" | "sizeM2">): ListingKind {
  if (listing.kind) return listing.kind;
  const text = [listing.title, listing.description, ...listing.features].join("\n");
  if (/\b(?:shared\s+(?:kitchen|bathroom|facilities)|(?:kitchen|bathroom) (?:is )?shared|gedeelde?\s+(?:keuken|badkamer))\b/i.test(text)) return "room";
  if (/\bstudio\b/i.test(listing.title)) return "studio";
  if (/\b(?:apartment|appartement|flat)\b/i.test(listing.title)) return "apartment";
  const selfContained = /\b(?:self[ -]contained|zelfstandig\w*)\b/i.test(text) ||
    [/\b(?:private|own) kitchen\b|\beigen keuken\b/i, /\b(?:private|own) bathroom\b|\beigen badkamer\b/i].every((pattern) => pattern.test(text));
  if (selfContained) return listing.sizeM2 !== null && listing.sizeM2 <= 40 ? "studio" : "apartment";
  // Use the room category when the ad offers too little evidence to infer a kind.
  return "room";
}

function medianSizes(listings: Pick<LiveListing, "kind" | "title" | "description" | "features" | "sizeM2">[]): SizeMedians {
  const byKind: Record<ListingKind, number[]> = { room: [], studio: [], apartment: [] };
  for (const listing of listings) {
    if (listing.sizeM2 !== null && listing.sizeM2 > 0) byKind[kindOf(listing)].push(listing.sizeM2);
  }
  const medians: SizeMedians = {};
  for (const kind of ["room", "studio", "apartment"] as const) {
    const sizes = byKind[kind].sort((a, b) => a - b);
    if (sizes.length === 0) continue;
    const middle = Math.floor(sizes.length / 2);
    medians[kind] = sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2;
  }
  return medians;
}

const mockSizes = medianSizes(mockListings);

export function catalogRows(value: unknown): CatalogPlace[] {
  if (!Array.isArray(value)) return [];
  return value.filter((place): place is CatalogPlace =>
    place && (place.kind === "supermarket" || place.kind === "gym") &&
    typeof place.name === "string" && !!place.name.trim() &&
    coordinate(place.lat, 90) && coordinate(place.lon, 180));
}

function readLocalAmenities(): CatalogPlace[] {
  const path = process.env.HOUSEWATCH_AMENITIES_FILE;
  if (!path) return [];
  try {
    const catalog: unknown = JSON.parse(readFileSync(path, "utf8"));
    return catalogRows(catalogPlaces(catalog, { requireBoth: false }));
  } catch {
    return [];
  }
}

export function readUiAmenities(path: string): CatalogPlace[] {
  const local = readLocalAmenities();
  if (local.some((place) => place.kind === "gym") && local.some((place) => place.kind === "supermarket")) return local;
  const store = openExistingStore(path);
  if (!store) return local;
  try {
    const places = [...local];
    for (const key of ["travel.catalog.local", "travel.catalog.v1"]) {
      const cached = catalogRows(store.getConfig(key)?.places);
      const existingKinds = new Set(places.map((place) => place.kind));
      places.push(...cached.filter((place) => !existingKinds.has(place.kind)));
    }
    return places;
  } finally {
    store.close();
  }
}

function fromCatalog(places: CatalogPlace[], lat: number, lng: number, kind: NearbyPlace["kind"]): NearbyPlace | undefined {
  const place = nearest(places, { lat, lon: lng }, kind);
  if (!place) return undefined;
  return { name: place.name, kind, lat: place.lat, lng: place.lon };
}

export function toUiListing(live: LiveListing, now: string, options: ConversionOptions = {}): Listing | null {
  const { lat, lng, precision, houseNumber, ...address } = live.location;
  const hasCoordinates = coordinate(lat, 90) && coordinate(lng, 180);
  const rent = live.costs.rent ?? live.advertisedRent;
  let { nearestSupermarket, nearestGym } = live;
  if (hasCoordinates && (!nearestSupermarket || !nearestGym)) {
    const places = (options.amenities ?? readLocalAmenities)();
    nearestSupermarket ??= fromCatalog(places, lat, lng, "supermarket");
    nearestGym ??= fromCatalog(places, lat, lng, "gym");
  }

  const reasons: SkipReason[] = [];
  if (!hasCoordinates) reasons.push("noCoordinates");
  if (rent === null) reasons.push("noRent");
  if (!nearestSupermarket || !nearestGym) reasons.push("awaitingTravelData");
  if (live.photos.length === 0) reasons.push("noPhotos");
  if (!hasCoordinates || rent === null || !nearestSupermarket || !nearestGym || live.photos.length === 0) {
    options.onSkip?.(reasons);
    return null;
  }

  const { id, title, description, registration, restrictions, eligibility, features, photos, history, listedAt, transitToAula } = live;
  const flags = [...live.flags];
  function missing(field: FlagField, message: string, key: string = field, previous?: string) {
    if (flags.some((flag) => flag.kind === "missing" && flag.field === field && flag.message === message)) return;
    const index = previous ? flags.findIndex((flag) => flag.kind === "missing" && flag.field === field && flag.message === previous) : -1;
    if (index >= 0) flags[index] = { ...flags[index], message };
    else flags.push({ id: `${live.id}-ui-${key}`, field, kind: "missing", message });
  }

  if (live.costs.rent === null) missing("price", "The ad gives one monthly amount without a breakdown.", "price", "The primary ad does not establish a separate base rent.");
  if (live.costs.billsIncluded === null) missing("bills", "The ad does not say whether bills are included.", "bills", "The primary ad does not establish the full monthly cost of bills and charges.");
  if (live.tenancy.availableFrom === null) missing("availability", "The ad does not give an exact move-in date.", "availability", "The primary ad does not establish an exact move-in date.");
  if (precision === null) missing("address", "The ad does not establish how precise this location is.");
  if (live.furnishing === null) missing("furnishing", "The ad does not state the furnishing.");
  if (live.sizeM2 === null || live.sizeM2 <= 0) missing("size", "The ad does not state the floor area.");
  if (live.bedrooms === null) missing("size", "The ad does not state the bedroom count.", "bedrooms");

  const kind = kindOf(live);
  const sources = live.sources.map((source) => {
    if (source.rent === null) missing("price", `The ad from ${source.name} does not give a monthly rent.`, `source-${source.id}`);
    return { ...source, rent: source.rent ?? rent };
  });
  const { previousRent, ...costs } = live.costs;
  const hasBaseRent = live.costs.rent !== null;

  return {
    id, title, description, registration, restrictions, eligibility, features, photos, history, listedAt, transitToAula,
    ...(live.travelTimes ? { travelTimes: live.travelTimes } : {}),
    kind,
    location: {
      ...address, lat, lng,
      precision: precision ?? (address.street ? "street" : "postcode"),
      ...(precision === "exact" && houseNumber ? { houseNumber } : {}),
    },
    sizeM2: live.sizeM2 !== null && live.sizeM2 > 0 ? live.sizeM2 : options.sizes?.[kind] ?? mockSizes[kind]!,
    bedrooms: live.bedrooms ?? 1,
    furnishing: live.furnishing ?? "upholstered",
    costs: {
      ...costs,
      rent,
      serviceCosts: hasBaseRent ? live.costs.serviceCosts : null,
      utilities: hasBaseRent ? live.costs.utilities : null,
      billsIncluded: live.costs.billsIncluded ?? false,
      ...(hasBaseRent && previousRent !== undefined ? { previousRent } : {}),
    },
    tenancy: { ...live.tenancy, availableFrom: live.tenancy.availableFrom ?? now.slice(0, 10) },
    sources,
    flags,
    nearestSupermarket,
    nearestGym,
  };
}

export function toUiFeed(feed: ListingsResult, now: string, loadAmenities: () => CatalogPlace[]): UiFeed {
  const skipped: Record<SkipReason, number> = { noCoordinates: 0, noRent: 0, awaitingTravelData: 0, noPhotos: 0 };
  if (feed.source === "mock") return { ...feed, skipped };
  const sizes = medianSizes(feed.listings);
  let catalog: CatalogPlace[] | undefined;
  const options = {
    sizes,
    amenities: () => catalog ??= loadAmenities(),
    onSkip: (reasons: SkipReason[]) => {
      for (const reason of reasons) skipped[reason]++;
    },
  };
  const listings = feed.listings.map((listing) => toUiListing(listing, now, options))
    .filter((listing): listing is Listing => listing !== null);
  return { ...feed, listings, skipped };
}
