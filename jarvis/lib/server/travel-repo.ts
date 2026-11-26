import "server-only";
import { openStore, storeKind } from "../../core/open-store.mjs";
import { createTravelService } from "../../core/travel.mjs";
import { listings as mockListings } from "../listings/data.ts";
import { DEFAULT_UNIVERSITY } from "../universities.ts";
import { hasDelftListings, isDelftListing } from "./listings-data.ts";
import { travelDetail, type TravelDetail } from "./listing-travel.ts";
import { hasSupabaseListings, readSupabaseListingTravel } from "./supabase-feed.ts";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;
type Store = NonNullable<Awaited<ReturnType<typeof openStore>>>;
type Session = { store: Store; service: ReturnType<typeof createTravelService>; requests: number };
let writer: Promise<Session | null> | undefined;

function mockTravel(id: string): TravelDetail | null {
  const listing = mockListings.find((item) => item.id === id);
  if (!listing) return null;
  const minutes = { walk: null, bike: null, transit: null };
  const campus = listing.travelTimes?.[DEFAULT_UNIVERSITY];
  return {
    source: "mock",
    status: "mock",
    approximate: listing.location.precision !== "exact",
    checkedAt: null,
    isStale: false,
    aula: campus ? { walk: campus.walk, bike: campus.bike, transit: campus.transit } : { ...minutes, transit: listing.transitToAula },
    ...(listing.travelTimes ? { travelTimes: listing.travelTimes } : {}),
    nearestSupermarket: listing.nearestSupermarket ? { ...listing.nearestSupermarket, minutes } : null,
    nearestGym: listing.nearestGym ? { ...listing.nearestGym, minutes } : null,
  };
}

async function missingTravel(store: Store, id: string) {
  const mock = mockTravel(id);
  return mock && !hasDelftListings(await store.getListings()) ? mock : null;
}

export async function getTravel(id: string): Promise<TravelDetail | null> {
  if (storeKind() === "supabase") {
    const display = await readSupabaseListingTravel(id);
    if (display) return travelDetail(display);
    const mock = mockTravel(id);
    return mock && !(await hasSupabaseListings()) ? mock : null;
  }
  const store = await openStore({ existing: true, readOnly: true });
  if (!store) return mockTravel(id);
  try {
    const listing = await store.getListing(id);
    if (!isDelftListing(listing)) return await missingTravel(store, id);
    return travelDetail(await createTravelService(store).display(listing));
  } finally {
    await store.close();
  }
}

export async function checkTravel(id: string): Promise<TravelDetail | null> {
  const remote = storeKind() === "supabase";
  if (remote && !process.env.SUPABASE_DB_URL) return getTravel(id);
  writer ??= openStore({ existing: true }).then((store) =>
    store ? { store, service: createTravelService(store), requests: 0 } : null);
  const pending = writer;
  let session;
  try {
    session = await pending;
  } catch (error) {
    if (writer === pending) writer = undefined;
    throw error;
  }
  if (!session) {
    if (writer === pending) writer = undefined;
    return mockTravel(id);
  }
  const { store, service } = session;
  session.requests++;
  try {
    const listing = await store.getListing(id);
    if (!isDelftListing(listing)) return await missingTravel(store, id);
    const display = await service.display(listing);
    // A manual origin is private. Cloud requests expose only public address results.
    if (remote && display.manual) return getTravel(id);
    const at = Date.now();
    if (display.status === "needs_location" || (display.checkedAt && Date.parse(display.checkedAt) > at - COOLDOWN_MS)) {
      return travelDetail(display);
    }
    if (!(await store.claimTravelCheck(id, at, COOLDOWN_MS))) {
      return travelDetail(await service.display(listing));
    }
    try {
      return travelDetail(await service.check(listing, {}));
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 503) {
        return { ...travelDetail(display), status: "provider_unavailable" };
      }
      if (error instanceof Error && "status" in error && error.status === 422) {
        return { ...travelDetail(display), status: "location_unresolved" };
      }
      throw error;
    }
  } finally {
    if (--session.requests === 0) {
      if (writer === pending) writer = undefined;
      await store.close();
    }
  }
}
