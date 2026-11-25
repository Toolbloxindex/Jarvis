import type { ListingView } from "./match";
import type { Furnishing, ListingKind, TenantKind } from "./types";

export type SortKey = "best" | "score" | "price-asc" | "price-desc" | "closest" | "newest";

export const SORT_LABELS: Record<SortKey, string> = {
  best: "Best match",
  score: "Highest score",
  "price-asc": "Lowest price",
  "price-desc": "Highest price",
  closest: "Closest to campus",
  newest: "Newest",
};

export type CommuteMode = "bike" | "transit" | "walk";

export interface Filters {
  /** Empty = every type. */
  kinds: ListingKind[];
  commuteMode: CommuteMode;
  /** Max minutes to TU Delft Aula by `commuteMode`. null = any. */
  maxCommute: number | null;
  /** Max walking minutes to the nearest supermarket / gym. */
  maxSupermarketWalk: number | null;
  maxGymWalk: number | null;
  /** Who's applying. Ads that exclude them are hidden; ads that don't say are kept. */
  tenant: TenantKind | null;
  couples: boolean;
  pets: boolean;
  minOverall: number | null;
  minTrust: number | null;
  minSafety: number | null;
  minSurroundings: number | null;
  minSize: number | null;
  furnishing: Furnishing | null;
  registrationOnly: boolean;
  billsIncludedOnly: boolean;
  /** Hide anything with open questions. */
  confirmedOnly: boolean;
}

export const EMPTY_FILTERS: Filters = {
  kinds: [],
  commuteMode: "bike",
  maxCommute: null,
  maxSupermarketWalk: null,
  maxGymWalk: null,
  tenant: null,
  couples: false,
  pets: false,
  minOverall: null,
  minTrust: null,
  minSafety: null,
  minSurroundings: null,
  minSize: null,
  furnishing: null,
  registrationOnly: false,
  billsIncludedOnly: false,
  confirmedOnly: false,
};

export function countActiveFilters(f: Filters) {
  return (
    Number(f.kinds.length > 0) +
    Number(f.maxCommute !== null) +
    Number(f.maxSupermarketWalk !== null) +
    Number(f.maxGymWalk !== null) +
    Number(f.tenant !== null) +
    Number(f.couples) +
    Number(f.pets) +
    Number(f.minOverall !== null) +
    Number(f.minTrust !== null) +
    Number(f.minSafety !== null) +
    Number(f.minSurroundings !== null) +
    Number(f.minSize !== null) +
    Number(f.furnishing !== null) +
    Number(f.registrationOnly) +
    Number(f.billsIncludedOnly) +
    Number(f.confirmedOnly)
  );
}

export function commuteMinutes(view: ListingView, mode: CommuteMode) {
  return mode === "bike" ? view.travel.bike : mode === "walk" ? view.travel.walk : view.travel.transit;
}

export function passesFilters(view: ListingView, f: Filters) {
  const { listing, scores } = view;
  if (f.kinds.length && !f.kinds.includes(listing.kind)) return false;
  if (f.maxCommute !== null) {
    const m = commuteMinutes(view, f.commuteMode);
    if (m === null || m > f.maxCommute) return false;
  }
  if (f.maxSupermarketWalk !== null && view.nearby.supermarket > f.maxSupermarketWalk) return false;
  if (f.maxGymWalk !== null && view.nearby.gym > f.maxGymWalk) return false;
  const e = listing.eligibility;
  if (f.tenant !== null && e?.tenants[f.tenant] === "no") return false;
  if (f.couples && e?.couples === "no") return false;
  if (f.pets && e?.pets === "no") return false;
  if (f.minOverall !== null && scores.overall.value < f.minOverall) return false;
  if (f.minTrust !== null && scores.trust.value < f.minTrust) return false;
  if (f.minSafety !== null && scores.safety.value < f.minSafety) return false;
  if (f.minSurroundings !== null && scores.surroundings.value < f.minSurroundings) return false;
  if (f.minSize !== null && listing.sizeM2 < f.minSize) return false;
  if (f.furnishing !== null && listing.furnishing !== f.furnishing) return false;
  if (f.registrationOnly && listing.registration !== "yes") return false;
  if (f.billsIncludedOnly && !listing.costs.billsIncluded) return false;
  if (f.confirmedOnly && view.toConfirm > 0) return false;
  return true;
}

const STATUS_RANK = { match: 0, confirm: 1, outside: 2 } as const;

export function sortViews(views: ListingView[], key: SortKey) {
  const sorted = [...views];
  switch (key) {
    case "best":
      return sorted.sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          b.scores.overall.value - a.scores.overall.value ||
          a.travel.bike - b.travel.bike,
      );
    case "score":
      return sorted.sort((a, b) => b.scores.overall.value - a.scores.overall.value);
    case "price-asc":
      return sorted.sort((a, b) => a.total - b.total);
    case "price-desc":
      return sorted.sort((a, b) => b.total - a.total);
    case "closest":
      return sorted.sort((a, b) => a.travel.km - b.travel.km);
    case "newest":
      return sorted.sort(
        (a, b) => new Date(b.listing.listedAt).getTime() - new Date(a.listing.listedAt).getTime(),
      );
  }
}

/** Monthly totals bucketed for the budget histogram. */
export function priceHistogram(totals: number[], min: number, max: number, buckets: number) {
  const counts = new Array<number>(buckets).fill(0);
  const step = (max - min) / buckets;
  for (const total of totals) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((total - min) / step)));
    counts[i] += 1;
  }
  return { counts, step };
}
