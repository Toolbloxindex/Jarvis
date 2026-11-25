export type ListingKind = "room" | "studio" | "apartment";

/** Dutch rentals come furnished, "gestoffeerd" (floors + curtains) or bare. */
export type Furnishing = "furnished" | "upholstered" | "unfurnished";

/** How precisely the source disclosed the address. Drives "approximate" travel labels. */
export type LocationPrecision = "exact" | "street" | "postcode";

export type TriState = "yes" | "no" | "unknown";

export type SourceKind = "platform" | "agent" | "email" | "group";

export interface Photo {
  src: string;
  alt: string;
  /** Tiny base64 data URL used as a blur-up placeholder. */
  blur?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface ListingLocation extends GeoPoint {
  precision: LocationPrecision;
  street: string;
  /** Only present when precision === "exact". */
  houseNumber?: string;
  postcode: string;
  neighbourhood: string;
}

export interface Costs {
  /** Base rent ("kale huur") in EUR per month. */
  rent: number;
  /** Service costs in EUR per month. null = not stated by the source. */
  serviceCosts: number | null;
  /** Gas / water / electricity / internet estimate. null = not stated. Ignored when billsIncluded. */
  utilities: number | null;
  billsIncluded: boolean;
  /** Deposit in EUR. null = not stated. */
  deposit: number | null;
  /** Previous base rent, when the price dropped recently. */
  previousRent?: number;
}

export interface Tenancy {
  /** ISO date (YYYY-MM-DD). */
  availableFrom: string;
  /** null = not stated. */
  minMonths: number | null;
  /** "indefinite" = open-ended contract, null = not stated. */
  maxMonths: number | "indefinite" | null;
}

export interface ListingSource {
  id: string;
  /** e.g. "Pararius", "Kamernet", "Saved search email", or a local agent's name. */
  name: string;
  kind: SourceKind;
  /** Link to the original advertisement (mock). */
  url: string;
  /** Base rent as advertised by this source. Can differ between sources. */
  rent: number;
  /** ISO datetime. */
  lastCheckedAt: string;
}

export type HistoryEventKind =
  | "listed"
  | "price"
  | "availability"
  | "duplicate"
  | "relisted";

export interface HistoryEvent {
  /** ISO date. */
  date: string;
  kind: HistoryEventKind;
  label: string;
  rent?: number;
}

export type FlagField =
  | "bills"
  | "tenancy"
  | "registration"
  | "address"
  | "availability"
  | "restrictions"
  | "deposit"
  | "furnishing"
  | "size"
  | "price";

export interface ReviewFlag {
  id: string;
  field: FlagField;
  /** missing = not stated anywhere, conflict = sources disagree. */
  kind: "missing" | "conflict";
  /** Plain sentence, e.g. "Kamernet lists €850, the agent's site lists €895." */
  message: string;
}

export interface NearbyPlace extends GeoPoint {
  name: string;
  kind: "supermarket" | "gym";
}

export type TenantKind = "bsc" | "msc" | "phd" | "professional";

/**
 * Who the ad accepts, read from structured fields or from the ad text.
 * "unknown" = the ad doesn't say; filters keep those and mark them to confirm.
 */
export interface Eligibility {
  tenants: Record<TenantKind, TriState>;
  couples: TriState;
  pets: TriState;
  /** structured = the source has a field for it; text = parsed from the description. */
  basis: "structured" | "text";
}

export interface Listing {
  id: string;
  kind: ListingKind;
  /** Short display title, usually the street, e.g. "Oude Delft". */
  title: string;
  /** 2–3 sentence description in a calm, factual tone. */
  description: string;
  location: ListingLocation;
  sizeM2: number;
  /** Bedrooms for apartments; 1 for rooms/studios. */
  bedrooms: number;
  furnishing: Furnishing;
  costs: Costs;
  tenancy: Tenancy;
  registration: TriState;
  /** Applicant restrictions as advertised, e.g. "Students only", "1 person". */
  restrictions: string[];
  /** Who can apply, derived from `restrictions` and the ad text. */
  eligibility: Eligibility;
  /** Short feature list, e.g. "Canal view", "Shared kitchen with 3". */
  features: string[];
  photos: Photo[];
  /** First entry is the primary source. Several entries = linked duplicates. */
  sources: ListingSource[];
  history: HistoryEvent[];
  flags: ReviewFlag[];
  /** ISO datetime of first sighting. */
  listedAt: string;
  /** Public transport minutes to TU Delft Aula. null = no timetable data. */
  transitToAula: number | null;
  nearestSupermarket: NearbyPlace;
  nearestGym: NearbyPlace;
}

/** What the person is searching for. */
export interface SearchCriteria {
  /** Latest acceptable move-in date (ISO). null = any. */
  moveInBy: string | null;
  /** Planned stay length in months. null = flexible. */
  stayMonths: number | null;
  /** Max monthly total incl. bills. null = any. */
  budget: number | null;
}
