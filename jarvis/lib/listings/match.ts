import { formatDay, formatEUR, formatMonths, hoursBetween, isAvailableNow } from "./format";
import { estimateTravel, type TravelEstimate } from "./geo";
import { overallScore, safetyScore, surroundingsScore, trustScore, type ListingScores } from "./scores";
import type { University } from "../universities";
import type { Costs, FlagField, Listing, SearchCriteria } from "./types";

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

const DAY = 86_400_000;
const AVG_MONTH_DAYS = 30.44;
const dayNum = (iso: string) => Math.floor(new Date(`${iso.slice(0, 10)}T12:00:00Z`).getTime() / DAY);
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** "3 days", "2 weeks", "about a month", "2 months". */
export function formatSpan(days: number) {
  const d = Math.abs(Math.round(days));
  if (d < 10) return `${d} ${d === 1 ? "day" : "days"}`;
  if (d < 25) {
    const w = Math.round(d / 7);
    return w === 1 ? "1 week" : `${w} weeks`;
  }
  if (d < 45) return "about a month";
  return `${Math.round(d / AVG_MONTH_DAYS)} months`;
}

/** Move-in: a window around the target date. Earlier is negotiable, later is not. */
export function checkMoveIn(
  listing: Listing,
  criteria: Pick<SearchCriteria, "moveIn" | "moveInFlexDays">,
  now: string,
): FitCheck {
  const from = listing.tenancy.availableFrom;
  const when = isAvailableNow(from, now) ? "Available now" : `Available from ${formatDay(from, now)}`;
  if (criteria.moveIn === null) return { key: "moveIn", status: "pass", label: "Any move-in date", detail: when };

  const target = dayNum(criteria.moveIn);
  const flex = criteria.moveInFlexDays;
  const lo = Math.max(dayNum(now), target - flex);
  const hi = target + flex;
  const a = dayNum(from);
  const windowText = flex === 0 ? formatDay(criteria.moveIn, now) : `${formatDay(isoOf(lo), now)} to ${formatDay(isoOf(hi), now)}`;

  if (a > hi) {
    return {
      key: "moveIn",
      status: "fail",
      label: "Available too late",
      detail: `${when}, ${formatSpan(a - target)} after you want to move in`,
    };
  }
  if (a >= lo) {
    return { key: "moveIn", status: "pass", label: "Available in your window", detail: `${when} (you: ${windowText})` };
  }
  return {
    key: "moveIn",
    status: "unknown",
    label: "Available earlier",
    detail: `${when}, ${formatSpan(target - a)} before you need it. Ask if it can start later.`,
  };
}

const fullDayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** "1 Jul 2027": contract ends are far enough out that the year matters. */
const fullDay = (n: number) => fullDayFormat.format(new Date(n * DAY + DAY / 2));

/** `months` calendar months after day `n`, clamped to the target month's last day. */
function addMonthsN(n: number, months: number) {
  const d = new Date(n * DAY);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return dayNum(target.toISOString());
}

/**
 * Stay: does the contract cover the dates you need? The stay runs from the later of
 * availability and your move-in to your move-out (null = indefinite).
 */
export function checkStay(
  listing: Listing,
  criteria: Pick<SearchCriteria, "moveIn" | "moveOut" | "moveOutFlexDays">,
): FitCheck {
  const { availableFrom, minMonths, maxMonths } = listing.tenancy;
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

  const start = Math.max(dayNum(availableFrom), dayNum(criteria.moveIn ?? availableFrom));

  if (criteria.moveOut === null) {
    // Indefinite: open-ended contracts fit; a fixed term means moving again.
    if (typeof maxMonths === "number") {
      return {
        key: "stay",
        status: "unknown",
        label: `Fixed term, ends after ${formatMonths(maxMonths)}`,
        detail: `Ends ${fullDay(addMonthsN(start, maxMonths))}, and you have no move-out date`,
      };
    }
    return { key: "stay", status: "pass", label: "Open-ended fits", detail: describe };
  }

  const out = dayNum(criteria.moveOut);
  const flex = criteria.moveOutFlexDays;
  const outText = fullDay(out);

  if (typeof maxMonths === "number") {
    const end = addMonthsN(start, maxMonths);
    const endText = fullDay(end);
    if (end < out - flex) {
      return {
        key: "stay",
        status: "fail",
        label: "Contract too short",
        detail: `Fixed term ends ${endText}, you move out ${outText}`,
      };
    }
    if (end < out) {
      // Inside the person's own tolerance: it fits; say by how much.
      return {
        key: "stay",
        status: "pass",
        label: `Ends ${formatSpan(out - end)} early, within your flexibility`,
        detail: `Fixed term ends ${endText}, you move out ${outText}`,
      };
    }
  }

  if (minMonths !== null) {
    const minEnd = addMonthsN(start, minMonths);
    const minText = fullDay(minEnd);
    if (minEnd > out + flex) {
      return {
        key: "stay",
        status: "fail",
        label: "Minimum stay too long",
        detail: `Minimum ${formatMonths(minMonths)} runs to ${minText}, you move out ${outText}`,
      };
    }
    if (minEnd > out) {
      return {
        key: "stay",
        status: "pass",
        label: `Minimum runs ${formatSpan(minEnd - out)} past, within your flexibility`,
        detail: `Minimum ${formatMonths(minMonths)} runs to ${minText}`,
      };
    }
  }

  return { key: "stay", status: "pass", label: "Stay fits", detail: describe };
}

export function travelFor(listing: Listing, university: University): TravelEstimate {
  const routed = listing.travelTimes?.[university.id];
  if (routed) {
    return {
      km: routed.km,
      walk: routed.walk,
      bike: routed.bike,
      transit: routed.transit,
      // The origin's precision decides "≈" on every mode; an estimated transit time only on transit.
      approximate: listing.location.precision !== "exact",
      transitEstimated: routed.source === "estimated" || (routed.approximate && routed.transit !== null),
    };
  }
  // No routed data yet: a straight-line estimate, always shown as approximate.
  const estimate = estimateTravel(listing.location, university, university.id === "tud" ? listing.transitToAula : null);
  return { ...estimate, approximate: true };
}

export function viewListing(
  listing: Listing,
  criteria: SearchCriteria,
  university: University,
  now: string,
  medianPerM2: number,
): ListingView {
  const { total, complete } = monthlyTotal(listing.costs);
  const checks = [
    checkBudget(listing, criteria.budget),
    checkMoveIn(listing, criteria, now),
    checkStay(listing, criteria),
  ];

  const unclear = new Set<FlagField>(listing.flags.map((f) => f.field));
  for (const check of checks) {
    if (check.status !== "unknown") continue;
    unclear.add(check.key === "budget" ? "bills" : check.key === "moveIn" ? "availability" : "tenancy");
  }

  const status: MatchStatus = checks.some((c) => c.status === "fail")
    ? "outside"
    : unclear.size > 0
      ? "confirm"
      : "match";

  const travel = travelFor(listing, university);
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
