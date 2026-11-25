import "server-only";
import { databasePath, openExistingStore } from "../../core/runtime.mjs";
import { createTravelService } from "../../core/travel.mjs";
import { listings as mockListings } from "../listings/data.ts";
import { hasDelftListings, isDelftListing } from "./listings-data.ts";
import { travelDetail, type TravelDetail } from "./listing-travel.ts";

type Store = NonNullable<ReturnType<typeof openExistingStore>>;
type Session = { store: Store; service: ReturnType<typeof createTravelService>; requests: number };
let writer: Session | undefined;

function mockTravel(id: string): TravelDetail | null {
  const listing = mockListings.find((item) => item.id === id);
  if (!listing) return null;
  const minutes = { walk: null, bike: null, transit: null };
  return {
    source: "mock",
    status: "mock",
    approximate: listing.location.precision !== "exact",
    checkedAt: null,
    isStale: false,
    aula: { ...minutes, transit: listing.transitToAula },
    nearestSupermarket: listing.nearestSupermarket ? { ...listing.nearestSupermarket, minutes } : null,
    nearestGym: listing.nearestGym ? { ...listing.nearestGym, minutes } : null,
  };
}

function missingTravel(store: Store, id: string) {
  return hasDelftListings(store.getListings()) ? null : mockTravel(id);
}

export function getTravel(id: string): TravelDetail | null {
  const store = openExistingStore(databasePath());
  if (!store) return mockTravel(id);
  try {
    const listing = store.getListing(id);
    return isDelftListing(listing) ? travelDetail(createTravelService(store).display(listing)) : missingTravel(store, id);
  } finally {
    store.close();
  }
}

export async function checkTravel(id: string): Promise<TravelDetail | null> {
  if (!writer) {
    const store = openExistingStore(databasePath(), false);
    if (!store) return mockTravel(id);
    writer = { store, service: createTravelService(store), requests: 0 };
  }
  const session = writer;
  const { store, service } = session;
  session.requests++;
  try {
    const listing = store.getListing(id);
    if (!isDelftListing(listing)) return missingTravel(store, id);
    try {
      return travelDetail(await service.check(listing, {}));
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 503) {
        return { ...travelDetail(service.display(listing)), status: "provider_unavailable" };
      }
      if (error instanceof Error && "status" in error && error.status === 422) {
        return { ...travelDetail(service.display(listing)), status: "location_unresolved" };
      }
      throw error;
    }
  } finally {
    if (--session.requests === 0) {
      writer = undefined;
      store.close();
    }
  }
}
