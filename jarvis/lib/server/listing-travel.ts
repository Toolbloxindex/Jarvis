import type { Listing, NearbyPlace } from "../listings/types";
import { DEFAULT_UNIVERSITY } from "../universities.ts";

type Mode = "walk" | "bike" | "transit";
type Minutes = Record<Mode, number | null>;
type Route = { status: string; seconds?: number };
type Destination = {
  id?: string;
  kind: NearbyPlace["kind"] | "campus";
  name: string;
  lat: number;
  lon: number;
  routes?: Partial<Record<Mode, Route>>;
};

export interface TravelDisplay {
  status: string;
  origin?: { lat?: number; lon?: number; precision: string } | null;
  manual?: boolean;
  destinations?: Destination[];
  travelTimes?: Listing["travelTimes"];
  sampleDeparture?: string;
  checkedAt?: string;
  isStale?: boolean;
}

export type TravelPlace = NearbyPlace & { minutes: Minutes };
export type TravelDetail = {
  source: "live" | "mock";
  status: string;
  approximate: boolean;
  checkedAt: string | null;
  isStale: boolean;
  aula: Minutes;
  travelTimes?: Listing["travelTimes"];
  nearestSupermarket: TravelPlace | null;
  nearestGym: TravelPlace | null;
};

export function minute(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value / 60) : null;
}

export function travelDetail(display: TravelDisplay, now = Date.now()): TravelDetail {
  const { destinations = [], checkedAt = null, origin, sampleDeparture } = display;
  const validTransit = !!sampleDeparture && Date.parse(sampleDeparture) > now;
  const find = (kind: Destination["kind"]) => destinations.find((destination) => destination.kind === kind);
  const times = (destination?: Destination): Minutes => {
    const route = (mode: Mode) => destination?.routes?.[mode];
    const get = (mode: Mode) => route(mode)?.status === "ok" ? minute(route(mode)?.seconds) : null;
    return { walk: get("walk"), bike: get("bike"), transit: validTransit ? get("transit") : null };
  };
  const nearby = (kind: NearbyPlace["kind"]): TravelPlace | null => {
    const place = find(kind);
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return null;
    return { kind, name: place.name, lat: place.lat, lng: place.lon, minutes: times(place) };
  };
  const campus = destinations.find((destination) => destination.id === DEFAULT_UNIVERSITY) ?? find("campus");
  const universityTimes = display.travelTimes?.[DEFAULT_UNIVERSITY];
  const status = display.status === "checked" && destinations.some((destination) =>
    Object.values(destination.routes ?? {}).some((route) => route.status === "unavailable")) ?
    "provider_unavailable" : display.status;
  return {
    source: "live",
    status,
    approximate: !!origin && origin.precision !== "address",
    checkedAt,
    isStale: display.isStale ?? false,
    aula: universityTimes ? { walk: universityTimes.walk, bike: universityTimes.bike, transit: universityTimes.transit } : times(campus),
    ...(display.travelTimes ? { travelTimes: display.travelTimes } : {}),
    nearestSupermarket: nearby("supermarket"),
    nearestGym: nearby("gym"),
  };
}
