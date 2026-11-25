import { SOURCES } from "../../core/discovery.mjs";
import { applyEvidenceBackedFacts } from "../../core/matcher.mjs";
import { normalizePhotos } from "../../core/photos.mjs";
import { openExistingStore } from "../../core/runtime.mjs";
import { canonicalUrl } from "../../core/store.mjs";
import { createTravelService, listingAddress } from "../../core/travel.mjs";
import { listings as mockListings } from "../listings/data.ts";
import type {
  Costs, FlagField, Furnishing, HistoryEvent, Listing, ListingKind, ListingLocation, ListingSource,
  ReviewFlag, Tenancy, TriState,
} from "../listings/types";
import { applicantRestrictions, listingEligibility, type ApplicantFacts } from "./listing-eligibility.ts";
import { travelDetail, type TravelDisplay } from "./listing-travel.ts";

type Nullable<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

type UnconfirmedDetails = "kind" | "furnishing" | "sizeM2" | "bedrooms";

export type LiveListing = Nullable<Omit<Listing, "location" | "costs" | "tenancy" | "sources" | "nearestGym" | "nearestSupermarket">, UnconfirmedDetails> & {
    location: Nullable<ListingLocation, "lat" | "lng" | "precision">;
    costs: Nullable<Costs, "rent" | "billsIncluded">;
    tenancy: Nullable<Tenancy, "availableFrom">;
    sources: Nullable<ListingSource, "rent">[];
    nearestGym?: Listing["nearestGym"];
    nearestSupermarket?: Listing["nearestSupermarket"];
    availability: string | null;
    advertisedRent: number | null;
  };

export type ListingsResult =
  | { listings: LiveListing[]; source: "live"; updatedAt: string | null }
  | { listings: Listing[]; source: "mock"; updatedAt: null };

interface Snapshot {
  rent_advertised_total?: number | null;
  rent_base?: number | null;
  rent_total?: number | null;
  start_date?: string | null;
  start_month?: string | null;
  end_date?: string | null;
  availability?: string | null;
  availability_periods?: { start?: string | null; end?: string | null }[] | null;
}

interface StoredListing extends ApplicantFacts, Snapshot {
  id: string;
  source: string;
  url?: string | null;
  city?: string | null;
  title?: string;
  address?: string | null;
  postcode?: string | null;
  neighbourhood?: string | null;
  location?: Partial<ListingLocation> | null;
  listing_kind?: string | null;
  duplicate_of?: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at?: string | null;
  wanted_ad?: boolean;
  sale_ad?: boolean;
  area_m2?: number | null;
  bedrooms?: number | null;
  furnished?: string | boolean | null;
  min_stay_months?: number | null;
  max_stay_months?: number | null;
  indefinite?: boolean | null;
  rent_excludes_bills?: boolean | null;
  deposit?: number | string | null;
  registration?: boolean | null;
  bills_missing?: string[];
  monthly_costs?: { label: string; amount: number; conditional?: boolean }[];
  photos?: { url: string; alt?: string }[];
  features?: string[];
  energy_label?: string | null;
  languages_required?: string[];
  age_min?: number | null;
  age_max?: number | null;
  household_restriction_unverified?: boolean;
  international_excluded?: boolean;
  weekdays_only?: boolean;
  income_requirement?: boolean;
  guarantor_mentioned?: boolean;
  source_detail_pending?: boolean;
  source_evidence_ambiguous?: boolean;
  property_details_checked?: boolean;
}

type Change = { listingId: string; kind: "price" | "availability"; before: Snapshot; after: Snapshot; changedAt: string };

const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const trim = (value?: string | null) => value?.trim() ?? "";
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const triState = (value: unknown): TriState => value === true ? "yes" : value === false ? "no" : "unknown";
const day = (value?: string | null) => {
  const date = value?.match(/^\d{4}-\d{2}-\d{2}(?=$|T)/)?.[0];
  if (!date || !Number.isFinite(Date.parse(date))) return null;
  return new Date(date).toISOString().slice(0, 10) === date ? date : null;
};
const quote = (row: Snapshot) => amount(row.rent_advertised_total) ?? amount(row.rent_base) ?? amount(row.rent_total);
const latest = (timestamps: (string | null | undefined)[]) => timestamps.reduce<string | null>((previous, value) =>
  value && Number.isFinite(Date.parse(value)) && (!previous || Date.parse(value) > Date.parse(previous)) ? value : previous, null);

export function isDelftListing(row: StoredListing | null): row is StoredListing {
  return !!row && trim(row.city).toLowerCase() === "delft" && row.listing_kind !== "general_lead" && !row.wanted_ad && !row.sale_ad;
}

function rentParts(row: StoredListing): LiveListing["costs"] {
  const charges = new Map<string, number>();
  for (const charge of row.monthly_costs ?? []) {
    const label = trim(charge.label).toLowerCase();
    const cost = amount(charge.amount);
    if (label && !charge.conditional && cost !== null && !charges.has(label)) charges.set(label, cost);
  }
  const utilityPattern = /utilit|heating|gas|water|electric|internet|energy|stook|energie|verwarming/;
  const servicePattern = /service|recurring|monthly charge/;
  let serviceCosts: number | null = null;
  let utilities: number | null = null;
  for (const [label, cost] of charges) {
    if (servicePattern.test(label)) serviceCosts = (serviceCosts ?? 0) + cost;
    else if (utilityPattern.test(label)) utilities = (utilities ?? 0) + cost;
    else serviceCosts = (serviceCosts ?? 0) + cost;
  }
  const deposit = typeof row.deposit === "string" && /^\d+(?:[.,]\d{1,2})?$/.test(row.deposit.trim()) ?
    amount(Number(row.deposit.replace(",", "."))) : amount(row.deposit);
  return {
    rent: amount(row.rent_base),
    serviceCosts,
    utilities,
    billsIncluded: typeof row.rent_excludes_bills === "boolean" ? !row.rent_excludes_bills : null,
    deposit,
  };
}

function availableFrom(row: Snapshot) {
  return day(row.start_date) ?? row.availability_periods?.map((period) => day(period.start)).filter(Boolean).sort()[0] ?? null;
}

function exactMonths(start: string | null, end: string | null) {
  if (!start || !end || end < start) return null;
  const [year, month, date] = start.split("-").map(Number);
  const [endYear, endMonth, endDate] = end.split("-").map(Number);
  const months = (endYear - year) * 12 + endMonth - month;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  const fullMonths = endDate < Math.min(date, lastDay) ? months - 1 : months;
  return fullMonths > 0 ? fullMonths : null;
}

function tenancy(row: StoredListing): LiveListing["tenancy"] {
  const start = availableFrom(row);
  const duration = exactMonths(day(row.start_date), day(row.end_date));
  return {
    availableFrom: start,
    minMonths: amount(row.min_stay_months),
    maxMonths: row.indefinite === true ? "indefinite" : amount(row.max_stay_months) ?? duration,
  };
}

function listingLocation(row: StoredListing, display: TravelDisplay): LiveListing["location"] {
  const input = listingAddress(row);
  const origin = display.manual ? null : display.origin;
  const source = row.location;
  const fromOrigin = origin?.precision === "address" ? "exact" :
    origin?.precision === "street" || origin?.precision === "postcode" ? origin.precision : null;
  const precision = fromOrigin ?? source?.precision ?? (input?.house ? "exact" : input?.code || row.postcode ? "postcode" : input?.street ? "street" : null);
  const postcode = trim(source?.postcode ?? row.postcode ?? input?.code).toUpperCase().replace(/^(\d{4})\s*([A-Z]{2})$/, "$1 $2");
  const lat = origin?.lat ?? source?.lat;
  const lng = origin?.lon ?? source?.lng;
  const positioned = typeof lat === "number" && Number.isFinite(lat) && typeof lng === "number" && Number.isFinite(lng);
  const houseNumber = precision === "exact" ? source?.houseNumber ?? input?.house : undefined;
  return {
    lat: positioned ? lat : null,
    lng: positioned ? lng : null,
    precision,
    street: trim(source?.street ?? input?.street),
    ...(houseNumber ? { houseNumber } : {}),
    postcode,
    neighbourhood: trim(source?.neighbourhood ?? row.neighbourhood),
  };
}

function listingKind(row: StoredListing): ListingKind | null {
  const typeUrl = row.source === "housinganywhere" || row.source === "roommatch" ? null : row.url;
  for (const value of [row.listing_kind, row.title, typeUrl, row.body?.slice(0, 200)]) {
    const term = value?.match(/\b(room|kamer|studentenkamer|studio|apartment|appartement|flat|house|woning)\b/i)?.[0].toLowerCase();
    if (!term) continue;
    if (term === "studio") return "studio";
    if (["room", "kamer", "studentenkamer"].includes(term)) return "room";
    return "apartment";
  }
  return null;
}

function furnishing(row: StoredListing): Furnishing | null {
  if (row.furnished === true || row.furnished === "furnished") return "furnished";
  if (row.furnished === "upholstered") return "upholstered";
  if (row.furnished === false || row.furnished === "unfurnished" || row.furnished === "uncarpeted") return "unfurnished";
  return null;
}

function sourceFor(row: StoredListing): LiveListing["sources"][number] {
  const source = SOURCES.find((entry) => entry.id === row.source);
  const kind = row.source === "facebook" ? "group" : /gmail|email|mail/.test(row.source) ? "email" :
    source?.kind === "agent" || row.source === "huizenbalie" ? "agent" : "platform";
  return {
    id: row.id,
    name: source?.name ?? (kind === "email" ? "Saved search email" : row.source),
    kind,
    url: canonicalUrl(row.url ?? ""),
    rent: amount(row.rent_base) ?? quote(row),
    lastCheckedAt: latest([row.last_seen_at]) ?? latest([row.updated_at, row.created_at]) ?? row.created_at,
  };
}

function valueChanged(a: unknown, b: unknown) {
  return a != null && b != null && JSON.stringify(a) !== JSON.stringify(b);
}

function formatAvailability(row: Snapshot) {
  if (row.availability === "unavailable") return "the listing is unavailable";
  const start = availableFrom(row) ?? row.start_month;
  const end = day(row.end_date);
  if (start && end) return `availability runs from ${start} to ${end}`;
  if (start) return `availability starts ${start}`;
  if (end) return `availability ends ${end}`;
  return row.availability === "available" ? "the listing is available" : "dates are unconfirmed";
}

function historyFor(group: StoredListing[], changes: Change[]) {
  const [primary, ...duplicates] = group;
  const sourceNames = new Map(group.map((row) => [row.id, sourceFor(row).name]));
  const primaryChanges = changes.filter((change) => change.listingId === primary.id && change.kind === "price");
  const firstRent = primaryChanges.length ? quote(primaryChanges[0].before) : quote(primary);
  const history: HistoryEvent[] = [
    { date: primary.created_at.slice(0, 10), kind: "listed", label: `Listed on ${sourceNames.get(primary.id)}`, ...(firstRent === null ? {} : { rent: firstRent }) },
    ...duplicates.map((row): HistoryEvent => ({
      date: row.created_at.slice(0, 10), kind: "duplicate", label: `Also found on ${sourceNames.get(row.id)}`,
    })),
  ];
  for (const change of changes) {
    const date = change.changedAt.slice(0, 10);
    const name = sourceNames.get(change.listingId);
    if (change.kind === "availability") {
      const relisted = change.before.availability === "unavailable" && change.after.availability === "available";
      history.push({ date, kind: relisted ? "relisted" : "availability", label: `${name} updated availability: ${formatAvailability(change.after)}.` });
      continue;
    }
    const baseChanged = valueChanged(change.before.rent_base, change.after.rent_base);
    const before = baseChanged ? amount(change.before.rent_base) : quote(change.before);
    const after = baseChanged ? amount(change.after.rent_base) : quote(change.after);
    const label = before !== null && after !== null && before !== after ?
      `${name} changed ${baseChanged ? "base rent" : "the advertised rent"} from ${money.format(before)} to ${money.format(after)}.` :
      `${name} updated the advertised rent details.`;
    history.push({ date, kind: "price", label, ...(after === null ? {} : { rent: after }) });
  }
  const previousRent = [...primaryChanges].reverse().find((change) =>
    change.before.rent_base !== change.after.rent_base)?.before.rent_base;
  return { history: history.sort((a, b) => a.date.localeCompare(b.date)), previousRent: amount(previousRent) };
}

function warningField(warning: string): FlagField | null {
  if (/deposit|one.time cost|borg/i.test(warning)) return "deposit";
  if (/registr|inschrij/i.test(warning)) return "registration";
  if (/tenancy length|rental period|\b(?:stay|stays|extension|minimum and maximum rental periods)\b/i.test(warning)) return "tenancy";
  if (/availability|calendar|start date|move.in day|end date/i.test(warning)) return "availability";
  if (/utilit|bill|service charge|heating|monthly charge|\bcost/i.test(warning)) return "bills";
  if (/rent|price/i.test(warning)) return "price";
  if (/household|student|tenant type|profe[sn]|guarantor|income|account.specific/i.test(warning)) return "restrictions";
  return null;
}

function reviewFlags(group: StoredListing[], listing: Pick<LiveListing, "costs" | "tenancy" | "location" | "registration" | "eligibility">) {
  const [row, ...duplicates] = group;
  const flags: ReviewFlag[] = [];
  const add = (field: FlagField, kind: ReviewFlag["kind"], message: string) => {
    if (!flags.some((flag) => flag.message === message)) flags.push({ id: `${row.id}-${field}-${flags.length + 1}`, field, kind, message });
  };
  const { costs, location, tenancy: mainTerm, eligibility } = listing;
  if (costs.rent === null) add("price", "missing", "The primary ad does not establish a separate base rent.");
  if (costs.billsIncluded === null || (costs.billsIncluded === false && (costs.utilities === null || row.bills_missing?.length))) {
    add("bills", "missing", "The primary ad does not establish the full monthly cost of bills and charges.");
  }
  if (costs.deposit === null) add("deposit", "missing", "The primary ad does not state a deposit amount.");
  if (listing.registration === "unknown") add("registration", "missing", "The primary ad does not establish whether municipal registration is possible.");
  if (location.precision !== "exact") add("address", "missing", "The primary ad does not give a full property address.");
  if (mainTerm.availableFrom === null) add("availability", "missing", "The primary ad does not establish an exact move-in date.");
  if (row.source_detail_pending || row.source_evidence_ambiguous || row.property_details_checked === false) {
    add("availability", "missing", "The full advertisement still needs to be checked.");
  }
  if (mainTerm.minMonths === null && mainTerm.maxMonths === null) add("tenancy", "missing", "The primary ad does not state a rental period.");
  if (typeof mainTerm.maxMonths === "number" && mainTerm.minMonths !== null && mainTerm.minMonths > mainTerm.maxMonths) {
    add("tenancy", "conflict", "The minimum rental period exceeds the maximum stated in the ad.");
  }
  if (Object.values(eligibility.tenants).every((state) => state === "unknown")) {
    add("restrictions", "missing", "The primary ad does not establish which applicant types it accepts.");
  }

  for (const ad of group) {
    const warnings = ad.extraction_warnings ?? [];
    if (ad.rent_total != null && ad.rent_excludes_bills === true) {
      add("bills", "conflict", "The ad gives an all-in amount but also lists excluded bills.");
    }
    for (const warning of warnings) {
      const field = warningField(warning);
      if (!field) continue;
      const kind = /conflict|differ|disagree|swap|while the description/i.test(warning) ? "conflict" : "missing";
      const message = warning.trim().split(/(?<=\.)\s+(?=[A-Z])/)[0];
      if (message) add(field, kind, /[.!?]$/.test(message) ? message : message + ".");
    }
  }
  for (const duplicate of duplicates) {
    const other = sourceFor(duplicate);
    const primary = sourceFor(row);
    const name = primary.name === other.name ? "The linked ads" : `${primary.name} and ${other.name}`;
    const otherCosts = rentParts(duplicate);
    if (costs.rent !== null && otherCosts.rent !== null && costs.rent !== otherCosts.rent) {
      add("price", "conflict", `${name} list different base rents of ${money.format(costs.rent)} and ${money.format(otherCosts.rent)}.`);
    } else if (costs.rent === null && otherCosts.rent === null && valueChanged(quote(row), quote(duplicate))) {
      add("price", "conflict", `${name} show different advertised monthly rents.`);
    }
    if (valueChanged(costs.billsIncluded, otherCosts.billsIncluded) || valueChanged(costs.serviceCosts, otherCosts.serviceCosts) || valueChanged(costs.utilities, otherCosts.utilities)) {
      add("bills", "conflict", `${name} give different bills or recurring charges.`);
    }
    if (valueChanged(costs.deposit, otherCosts.deposit)) add("deposit", "conflict", `${name} list different deposits.`);
    if (valueChanged(row.registration, duplicate.registration)) add("registration", "conflict", `${name} disagree on whether registration is possible.`);
    const otherTenancy = tenancy(duplicate);
    if (valueChanged(mainTerm.minMonths, otherTenancy.minMonths) || valueChanged(mainTerm.maxMonths, otherTenancy.maxMonths)) {
      add("tenancy", "conflict", `${name} state different rental periods.`);
    }
    if (valueChanged(mainTerm.availableFrom, otherTenancy.availableFrom) || valueChanged(row.availability, duplicate.availability) || valueChanged(row.end_date, duplicate.end_date)) {
      add("availability", "conflict", `${name} give different availability information.`);
    }
    const otherEligibility = listingEligibility(duplicate);
    const primaryRules = [...Object.values(eligibility.tenants), eligibility.couples, eligibility.pets];
    const otherRules = [...Object.values(otherEligibility.tenants), otherEligibility.couples, otherEligibility.pets];
    if (primaryRules.some((value, index) => value !== "unknown" && otherRules[index] !== "unknown" && value !== otherRules[index])) {
      add("restrictions", "conflict", `${name} describe different applicant restrictions.`);
    }
  }
  return flags;
}

function groupListings(rows: StoredListing[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, StoredListing[]>();
  for (const row of rows) {
    let root = row;
    const seen = new Set([row.id]);
    while (root.duplicate_of && byId.has(root.duplicate_of)) {
      if (seen.has(root.duplicate_of)) {
        const cycle = [...seen].slice([...seen].indexOf(root.duplicate_of)).sort();
        root = byId.get(cycle[0])!;
        break;
      }
      root = byId.get(root.duplicate_of)!;
      seen.add(root.id);
    }
    const group = groups.get(root.id) ?? [root];
    if (row.id !== root.id) group.push(row);
    groups.set(root.id, group);
  }
  return [...groups.values()];
}

export function hasDelftListings(rows: unknown[]) {
  return (rows as StoredListing[]).some(isDelftListing);
}

export function readListings(path: string): ListingsResult {
  const fallback = { listings: mockListings, source: "mock", updatedAt: null } as const;
  const store = openExistingStore(path);
  if (!store) return fallback;
  try {
    store.db.exec("BEGIN");
    const rows = (store.getListings() as StoredListing[]).filter(isDelftListing);
    if (rows.length === 0) return fallback;
    const changesById = new Map<string, Change[]>();
    for (const change of store.getListingHistory() as Change[]) {
      const changes = changesById.get(change.listingId) ?? [];
      changes.push(change);
      changesById.set(change.listingId, changes);
    }
    const travel = createTravelService(store);
    const listings = groupListings(rows).map((storedGroup): LiveListing => {
      const group = storedGroup.map((row) => applyEvidenceBackedFacts(row) as StoredListing);
      const row = group[0];
      const display: TravelDisplay = travel.display(row);
      const detail = travelDetail(display);
      const location = listingLocation(row, display);
      const kind = listingKind(row);
      const allChanges = group.flatMap((item) => changesById.get(item.id) ?? [])
        .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
      const { history, previousRent } = historyFor(group, allChanges);
      const costs = rentParts(row);
      if (costs.rent !== null && previousRent !== null && previousRent > costs.rent) costs.previousRent = previousRent;
      const duration = tenancy(row);
      const registration = triState(row.registration);
      const eligibility = listingEligibility(row);
      const photos = group.flatMap((item) => normalizePhotos(item.source, item.photos, item.url ?? undefined))
        .filter((photo, index, all) => index === all.findIndex((item) => item.url === photo.url))
        .map((photo, index) => ({ src: photo.url, alt: `Property photo ${index + 1}` }));
      const features = [...row.features ?? [], ...(row.energy_label ? [`Energy label ${row.energy_label}`] : [])];
      const { nearestSupermarket, nearestGym } = detail;
      return {
        id: row.id,
        kind,
        title: location.street || trim(row.title) || "Delft rental",
        description: trim(row.body),
        location,
        sizeM2: amount(row.area_m2),
        bedrooms: kind === "studio" || kind === "room" ? 1 : amount(row.bedrooms),
        furnishing: furnishing(row),
        costs,
        advertisedRent: quote(row),
        tenancy: duration,
        availability: row.availability ?? null,
        registration,
        restrictions: applicantRestrictions(row),
        eligibility,
        features,
        photos,
        sources: group.map(sourceFor),
        history,
        flags: reviewFlags(group, { costs, tenancy: duration, location, registration, eligibility }),
        listedAt: row.created_at,
        transitToAula: detail.aula.transit,
        ...(nearestSupermarket ? { nearestSupermarket: { kind: nearestSupermarket.kind, name: nearestSupermarket.name, lat: nearestSupermarket.lat, lng: nearestSupermarket.lng } } : {}),
        ...(nearestGym ? { nearestGym: { kind: nearestGym.kind, name: nearestGym.name, lat: nearestGym.lat, lng: nearestGym.lng } } : {}),
      };
    });
    return { listings, source: "live", updatedAt: latest(rows.flatMap((row) => [row.last_seen_at, row.updated_at])) };
  } finally {
    store.close();
  }
}
