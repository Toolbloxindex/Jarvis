import { formatDay, formatEUR, formatMonths, hoursBetween, isAvailableNow, isOnOrBefore } from "./format";
import { estimateTravel, type TravelEstimate } from "./geo";
import { overallScore, safetyScore, surroundingsScore, trustScore, type ListingScores } from "./scores";
import type { Costs, FlagField, GeoPoint, Listing, SearchCriteria } from "./types";

export type CheckStatus = "pass" | "fail" | "unknown";

export interface FitCheck {
  key: "budget" | "moveIn" | "stay";
  status: CheckStatus;
  label: string;
  detail: string;
}

/** match = fits the search, confirm = fits but something is unclear, outside = fails a criterion. */
export type MatchStatus = "match" | "confirm" | "outside";

export interface ListingView {
  listing: Listing;
  total: number;
  /** False when utilities aren't stated, so the total is a floor. */
  totalComplete: boolean;
  travel: TravelEstimate;
  checks: FitCheck[];
  status: MatchStatus;
  /** Distinct things the person should confirm with the source. */
  toConfirm: number;
  isNew: boolean;
  priceDropped: boolean;
  /** Walking minutes to the nearest supermarket and gym. */
  nearby: { supermarket: number; gym: number };
  scores: ListingScores;
}

export function monthlyTotal(costs: Costs) {
  const service = costs.serviceCosts ?? 0;
  const utilities = costs.billsIncluded ? 0 : (costs.utilities ?? 0);
  return {
    total: costs.rent + service + utilities,
    complete: costs.billsIncluded || costs.utilities !== null,
  };
}

export function checkBudget(listing: Listing, budget: number | null): FitCheck {
  const { total, complete } = monthlyTotal(listing.costs);
  if (budget === null) {
    return { key: "budget", status: "pass", label: "Any budget", detail: `${formatEUR(total)} a month` };
  }
  if (total > budget) {
    return {
      key: "budget",
      status: "fail",
      label: "Over budget",
      detail: `${formatEUR(total)} a month, ${formatEUR(total - budget)} over your ${formatEUR(budget)}`,
    };
  }
  if (!complete) {
    return {
      key: "budget",
      status: "unknown",
      label: "Utilities not stated",
      detail: `${formatEUR(total)} a month before utilities`,
    };
  }
  return {
    key: "budget",
    status: "pass",
    label: "Within budget",
    detail: `${formatEUR(total)} a month${listing.costs.billsIncluded ? ", bills included" : ""}`,
  };
}

export function checkMoveIn(listing: Listing, moveInBy: string | null, now: string): FitCheck {
  const from = listing.tenancy.availableFrom;
  const when = isAvailableNow(from, now) ? "Available now" : `Available from ${formatDay(from, now)}`;
  if (moveInBy === null || isOnOrBefore(from, moveInBy)) {
    return { key: "moveIn", status: "pass", label: "Available in time", detail: when };
  }
  return {
    key: "moveIn",
    status: "fail",
    label: "Available later",
    detail: `${when}, after your ${formatDay(moveInBy, now)} move-in`,
  };
}

export function checkStay(listing: Listing, stayMonths: number | null): FitCheck {
  const { minMonths, maxMonths } = listing.tenancy;
  const describe =
    maxMonths === "indefinite"
      ? minMonths
        ? `Open-ended, minimum ${formatMonths(minMonths)}`
        : "Open-ended contract"
      : typeof maxMonths === "number"
        ? `Fixed term, up to ${formatMonths(maxMonths)}`
        : minMonths
          ? `Minimum ${formatMonths(minMonths)}`
          : "Contract length not stated";

  if (minMonths === null && maxMonths === null) {
    return { key: "stay", status: "unknown", label: "Contract length not stated", detail: describe };
  }
  if (stayMonths !== null && typeof maxMonths === "number" && maxMonths < stayMonths) {
    return {
      key: "stay",
      status: "fail",
      label: "Contract too short",
      detail: `Ends after ${formatMonths(maxMonths)}, you need ${formatMonths(stayMonths)}`,
    };
  }
  if (stayMonths !== null && minMonths !== null && minMonths > stayMonths) {
    return {
      key: "stay",
      status: "fail",
      label: "Minimum stay too long",
      detail: `Minimum ${formatMonths(minMonths)}, you need ${formatMonths(stayMonths)}`,
    };
  }
  return { key: "stay", status: "pass", label: "Stay length fits", detail: describe };
}

export function viewListing(
  listing: Listing,
  criteria: SearchCriteria,
  campus: GeoPoint,
  now: string,
  medianPerM2: number,
): ListingView {
  const { total, complete } = monthlyTotal(listing.costs);
  const checks = [
    checkBudget(listing, criteria.budget),
    checkMoveIn(listing, criteria.moveInBy, now),
    checkStay(listing, criteria.stayMonths),
  ];

  const unclear = new Set<FlagField>(listing.flags.map((f) => f.field));
  for (const check of checks) {
    if (check.status !== "unknown") continue;
    unclear.add(check.key === "budget" ? "bills" : "tenancy");
  }

  const status: MatchStatus = checks.some((c) => c.status === "fail")
    ? "outside"
    : unclear.size > 0
      ? "confirm"
      : "match";

  const travel = estimateTravel(listing.location, campus, listing.transitToAula);
  const parts = {
    trust: trustScore(listing, now),
    safety: safetyScore(listing),
    surroundings: surroundingsScore(listing),
  };
  const overall = overallScore(parts, {
    status,
    bikeMinutes: travel.bike,
    total,
    sizeM2: listing.sizeM2,
    medianPerM2,
  });

  return {
    listing,
    total,
    totalComplete: complete,
    travel,
    checks,
    status,
    toConfirm: unclear.size,
    isNew: hoursBetween(listing.listedAt, now) <= 48,
    priceDropped: listing.costs.previousRent !== undefined && listing.costs.previousRent > listing.costs.rent,
    nearby: {
      supermarket: estimateTravel(listing.location, listing.nearestSupermarket).walk,
      gym: estimateTravel(listing.location, listing.nearestGym).walk,
    },
    scores: { overall, ...parts },
  };
}

/** The first failing check, for a one-line reason on cards outside the search. */
export function outsideReason(view: ListingView) {
  return view.checks.find((c) => c.status === "fail") ?? null;
}
