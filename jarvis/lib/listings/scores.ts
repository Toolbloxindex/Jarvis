import { distanceKm, estimateTravel } from "./geo";
import type { GeoPoint, Listing } from "./types";

/**
 * Scores are 0–10 with one decimal, and every score carries the reasons behind it,
 * so the interface can always explain a number instead of asking people to trust it.
 */
export interface ScoreFactor {
  label: string;
  /** Contribution in score points, signed. */
  delta: number;
}

export interface Score {
  value: number;
  factors: ScoreFactor[];
}

export interface ListingScores {
  overall: Score;
  trust: Score;
  safety: Score;
  surroundings: Score;
}

const clamp = (v: number, lo = 1, hi = 10) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

function finish(base: number, factors: ScoreFactor[]): Score {
  const value = round1(clamp(base + factors.reduce((s, f) => s + f.delta, 0)));
  return { value, factors: factors.filter((f) => f.delta !== 0) };
}

/** How much the ad itself can be relied on: agreeing sources, completeness, precision, freshness. */
export function trustScore(listing: Listing, now: string): Score {
  const f: ScoreFactor[] = [];
  const { sources, flags, location } = listing;
  const rents = new Set(sources.map((s) => s.rent));

  if (sources.length > 1 && rents.size === 1) f.push({ label: `${sources.length} sources agree on the rent`, delta: 1 });
  const priceConflicts = flags.filter((x) => x.field === "price" && x.kind === "conflict").length;
  if (priceConflicts) f.push({ label: "Sources disagree on the rent", delta: -1.5 * priceConflicts });
  const otherConflicts = flags.filter((x) => x.kind === "conflict" && x.field !== "price").length;
  if (otherConflicts) f.push({ label: "Sources disagree on the terms", delta: -0.8 * otherConflicts });
  const missing = flags.filter((x) => x.kind === "missing").length;
  if (missing) f.push({ label: `${missing} ${missing === 1 ? "detail" : "details"} not stated`, delta: -0.4 * missing });

  const kinds = new Set(sources.map((s) => s.kind));
  if (kinds.has("agent") || kinds.has("platform")) f.push({ label: "Listed by a platform or agent", delta: 0.5 });
  else if (kinds.has("group")) f.push({ label: "Only seen in a housing group", delta: -1 });

  if (location.precision === "exact") f.push({ label: "Exact address given", delta: 0.5 });
  if (location.precision === "postcode") f.push({ label: "Only a postcode given", delta: -1 });

  const newest = Math.max(...sources.map((s) => new Date(s.lastCheckedAt).getTime()));
  if (new Date(now).getTime() - newest < 24 * 3_600_000) f.push({ label: "Checked in the last day", delta: 0.3 });

  return finish(7, f);
}

/**
 * MOCK: neighbourhood baselines for the prototype. Replace with an open data source
 * (e.g. CBS / police open data per buurt) before showing this to real people.
 */
const NEIGHBOURHOOD_SAFETY: Record<string, number> = {
  Binnenstad: 7.9,
  Wippolder: 8.3,
  "Hof van Delft": 8.1,
  Vrijenban: 8.5,
  Voorhof: 7.6,
  Buitenhof: 7.7,
  "Tanthof-West": 8.4,
  "Tanthof-Oost": 8.4,
  Westerkwartier: 8.1,
  Kuyperwijk: 8.2,
};

export function safetyScore(listing: Listing): Score {
  const base = NEIGHBOURHOOD_SAFETY[listing.location.neighbourhood] ?? 7.9;
  const f: ScoreFactor[] = [];
  const text = `${listing.description} ${listing.features.join(" ")}`.toLowerCase();
  if (/ground floor|street level/.test(text)) f.push({ label: "Ground floor", delta: -0.3 });
  if (/bike storage|bike shed|courtyard/.test(text)) f.push({ label: "Covered bike storage", delta: 0.3 });
  const score = finish(base, f);
  return { ...score, factors: [{ label: `${listing.location.neighbourhood} neighbourhood average`, delta: 0 }, ...score.factors] };
}

const MARKT: GeoPoint = { lat: 52.0117085, lng: 4.3591943 };

/** Daily life around the home: groceries, gym, and how close the centre is. */
export function surroundingsScore(listing: Listing): Score {
  const f: ScoreFactor[] = [];
  const shop = estimateTravel(listing.location, listing.nearestSupermarket).walk;
  const gym = estimateTravel(listing.location, listing.nearestGym).walk;
  const centreKm = distanceKm(listing.location, MARKT) * 1.3;

  if (shop <= 4) f.push({ label: `Supermarket ${shop} min on foot`, delta: 1 });
  else if (shop > 8) f.push({ label: `Supermarket ${shop} min on foot`, delta: -Math.min(2, (shop - 8) * 0.2) });
  if (gym <= 8) f.push({ label: `Gym ${gym} min on foot`, delta: 0.5 });
  else if (gym > 15) f.push({ label: `Gym ${gym} min on foot`, delta: -0.6 });
  if (centreKm < 1) f.push({ label: "In or next to the centre", delta: 0.8 });
  else if (centreKm > 3) f.push({ label: `${centreKm.toFixed(1)} km from the centre`, delta: -Math.min(1.5, (centreKm - 3) * 0.5) });

  return finish(7.5, f);
}

export interface OverallInputs {
  status: "match" | "confirm" | "outside";
  bikeMinutes: number;
  total: number;
  sizeM2: number;
  /** Median price per m² across the feed, for a value comparison. */
  medianPerM2: number;
}

/** Weighted blend. Weights are visible in the factors so the number is never a black box. */
export function overallScore(parts: Omit<ListingScores, "overall">, input: OverallInputs): Score {
  const fit = input.status === "match" ? 10 : input.status === "confirm" ? 7.5 : 4;
  const travel = clamp(10 - Math.max(0, input.bikeMinutes - 5) * 0.3, 3, 10);
  const perM2 = input.total / Math.max(1, input.sizeM2);
  const value = clamp(7 + ((input.medianPerM2 - perM2) / input.medianPerM2) * 6, 2, 10);

  const weighted: Array<[string, number, number]> = [
    ["Fits your search", fit, 0.25],
    ["Time to campus", travel, 0.2],
    ["Trust", parts.trust.value, 0.2],
    ["Surroundings", parts.surroundings.value, 0.15],
    ["Value for money", value, 0.1],
    ["Safety", parts.safety.value, 0.1],
  ];
  const value10 = weighted.reduce((s, [, v, w]) => s + v * w, 0);
  return {
    value: round1(clamp(value10)),
    factors: weighted.map(([label, v, w]) => ({ label: `${label} (${Math.round(w * 100)}%)`, delta: round1(v) })),
  };
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
