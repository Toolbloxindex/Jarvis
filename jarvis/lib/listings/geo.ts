import type { GeoPoint, LocationPrecision } from "./types";

const EARTH_RADIUS_KM = 6371;

export function distanceKm(a: GeoPoint, b: GeoPoint) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Streets don't run in straight lines; this is a typical urban detour factor. */
const ROUTE_FACTOR = 1.3;
const WALK_KMH = 4.8;
const BIKE_KMH = 15;
/** Unlocking and parking the bike. */
const BIKE_OVERHEAD_MIN = 1;

export interface TravelEstimate {
  km: number;
  walk: number;
  bike: number;
  transit: number | null;
  /** True when the source only gave a street or postcode. */
  approximate: boolean;
  /** True when the transit time is a rail-based estimate rather than a timetable route. */
  transitEstimated?: boolean;
}

export function estimateTravel(
  from: GeoPoint & { precision?: LocationPrecision },
  to: GeoPoint,
  transit: number | null = null,
): TravelEstimate {
  const km = distanceKm(from, to) * ROUTE_FACTOR;
  return {
    km,
    walk: Math.max(1, Math.round((km / WALK_KMH) * 60)),
    bike: Math.max(2, Math.round((km / BIKE_KMH) * 60 + BIKE_OVERHEAD_MIN)),
    transit,
    approximate: from.precision !== undefined && from.precision !== "exact",
  };
}

export function formatKm(km: number) {
  return km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1)} km`;
}
