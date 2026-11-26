/**
 * Every Dutch research university and the main university-of-applied-sciences (HBO) campuses.
 * Coordinates are the building times are measured to, verified against PDOK Locatieserver
 * (the official Dutch address register) from each building's postal address.
 * Single source of truth for the UI, the collector (which cities to read) and core/travel.
 *
 * The first nine ids predate the national expansion and must stay stable: they are stored in
 * people's saved searches.
 */
export interface University {
  id: string;
  /** Full name, shown in the picker. */
  name: string;
  /** Short name for tight spaces ("to TU Delft"). */
  short: string;
  /** The building times are measured to. */
  place: string;
  /** Display city (English). */
  city: string;
  /** The student city whose homes this campus draws from (see STUDENT_CITIES). */
  region: StudentCityId;
  lat: number;
  lng: number;
}

/**
 * Cities the collector reads. `aliases` are the spellings sources use for the municipality;
 * `kamernet`/`housinganywhere` are the sources' search slugs (null = not searched there).
 * Centres are PDOK woonplaats centroids.
 */
export interface StudentCity {
  id: string;
  name: string;
  aliases: readonly string[];
  kamernet: string | null;
  housinganywhere: string | null;
  lat: number;
  lng: number;
}

export const STUDENT_CITIES = [
  { id: "delft", name: "Delft", aliases: ["delft"], kamernet: "delft", housinganywhere: "Delft", lat: 51.9985, lng: 4.3631 },
  { id: "rotterdam", name: "Rotterdam", aliases: ["rotterdam"], kamernet: "rotterdam", housinganywhere: "Rotterdam", lat: 51.9225, lng: 4.4865 },
  { id: "den-haag", name: "The Hague", aliases: ["den haag", "'s-gravenhage", "s-gravenhage", "the hague"], kamernet: "den-haag", housinganywhere: "The-Hague", lat: 52.0721, lng: 4.293 },
  { id: "leiden", name: "Leiden", aliases: ["leiden"], kamernet: "leiden", housinganywhere: "Leiden", lat: 52.155, lng: 4.4851 },
  { id: "amsterdam", name: "Amsterdam", aliases: ["amsterdam"], kamernet: "amsterdam", housinganywhere: "Amsterdam", lat: 52.3734, lng: 4.9045 },
  { id: "diemen", name: "Diemen", aliases: ["diemen"], kamernet: "diemen", housinganywhere: null, lat: 52.3373, lng: 4.9905 },
  { id: "amstelveen", name: "Amstelveen", aliases: ["amstelveen"], kamernet: "amstelveen", housinganywhere: null, lat: 52.2893, lng: 4.8515 },
  { id: "haarlem", name: "Haarlem", aliases: ["haarlem"], kamernet: "haarlem", housinganywhere: "Haarlem", lat: 52.3824, lng: 4.6467 },
  { id: "utrecht", name: "Utrecht", aliases: ["utrecht"], kamernet: "utrecht", housinganywhere: "Utrecht", lat: 52.0887, lng: 5.0952 },
  { id: "gouda", name: "Gouda", aliases: ["gouda"], kamernet: "gouda", housinganywhere: null, lat: 52.0153, lng: 4.7062 },
  { id: "groningen", name: "Groningen", aliases: ["groningen"], kamernet: "groningen", housinganywhere: "Groningen", lat: 53.2222, lng: 6.5633 },
  { id: "leeuwarden", name: "Leeuwarden", aliases: ["leeuwarden"], kamernet: "leeuwarden", housinganywhere: "Leeuwarden", lat: 53.2007, lng: 5.8031 },
  { id: "zwolle", name: "Zwolle", aliases: ["zwolle"], kamernet: "zwolle", housinganywhere: "Zwolle", lat: 52.5187, lng: 6.1184 },
  { id: "deventer", name: "Deventer", aliases: ["deventer"], kamernet: "deventer", housinganywhere: null, lat: 52.2501, lng: 6.1927 },
  { id: "enschede", name: "Enschede", aliases: ["enschede"], kamernet: "enschede", housinganywhere: "Enschede", lat: 52.2208, lng: 6.8778 },
  { id: "wageningen", name: "Wageningen", aliases: ["wageningen"], kamernet: "wageningen", housinganywhere: "Wageningen", lat: 51.9735, lng: 5.6635 },
  { id: "ede", name: "Ede", aliases: ["ede"], kamernet: "ede", housinganywhere: null, lat: 52.046, lng: 5.6849 },
  { id: "arnhem", name: "Arnhem", aliases: ["arnhem"], kamernet: "arnhem", housinganywhere: "Arnhem", lat: 52.0011, lng: 5.8926 },
  { id: "nijmegen", name: "Nijmegen", aliases: ["nijmegen"], kamernet: "nijmegen", housinganywhere: "Nijmegen", lat: 51.8348, lng: 5.8332 },
  { id: "eindhoven", name: "Eindhoven", aliases: ["eindhoven"], kamernet: "eindhoven", housinganywhere: "Eindhoven", lat: 51.4502, lng: 5.4585 },
  { id: "tilburg", name: "Tilburg", aliases: ["tilburg"], kamernet: "tilburg", housinganywhere: "Tilburg", lat: 51.5727, lng: 5.0453 },
  { id: "breda", name: "Breda", aliases: ["breda"], kamernet: "breda", housinganywhere: "Breda", lat: 51.5804, lng: 4.7556 },
  { id: "den-bosch", name: "'s-Hertogenbosch", aliases: ["'s-hertogenbosch", "s-hertogenbosch", "den bosch", "hertogenbosch"], kamernet: "den-bosch", housinganywhere: null, lat: 51.71, lng: 5.2957 },
  { id: "maastricht", name: "Maastricht", aliases: ["maastricht"], kamernet: "maastricht", housinganywhere: "Maastricht", lat: 50.853, lng: 5.6995 },
  { id: "heerlen", name: "Heerlen", aliases: ["heerlen"], kamernet: "heerlen", housinganywhere: null, lat: 50.888, lng: 5.9786 },
  { id: "vlissingen", name: "Vlissingen", aliases: ["vlissingen"], kamernet: "vlissingen", housinganywhere: null, lat: 51.4708, lng: 3.4433 },
  { id: "middelburg", name: "Middelburg", aliases: ["middelburg"], kamernet: "middelburg", housinganywhere: null, lat: 51.5026, lng: 3.6159 },
] as const satisfies readonly StudentCity[];

export type StudentCityId = (typeof STUDENT_CITIES)[number]["id"];

export const UNIVERSITIES = [
  // Delft, Rotterdam, Leiden, The Hague (original ids: keep stable).
  { id: "tud", name: "TU Delft", short: "TU Delft", place: "Aula", city: "Delft", region: "delft", lat: 52.0021922, lng: 4.3734709 },
  { id: "hhs-delft", name: "The Hague University of Applied Sciences", short: "THUAS Delft", place: "Delft campus", city: "Delft", region: "delft", lat: 52.0016196, lng: 4.3680178 },
  { id: "inholland-delft", name: "Inholland University of Applied Sciences", short: "Inholland Delft", place: "Delft campus", city: "Delft", region: "delft", lat: 52.0002595, lng: 4.3688991 },
  { id: "eur", name: "Erasmus University Rotterdam", short: "Erasmus", place: "Woudestein campus", city: "Rotterdam", region: "rotterdam", lat: 51.9176312, lng: 4.5259623 },
  { id: "hr", name: "Rotterdam University of Applied Sciences", short: "Hogeschool Rotterdam", place: "Museumpark", city: "Rotterdam", region: "rotterdam", lat: 51.9135409, lng: 4.4691951 },
  { id: "leiden", name: "Leiden University", short: "Leiden", place: "Academiegebouw", city: "Leiden", region: "leiden", lat: 52.1571451, lng: 4.4853784 },
  { id: "leiden-bsp", name: "Leiden University, Science Park", short: "Leiden Science Park", place: "Gorlaeus / LIACS", city: "Leiden", region: "leiden", lat: 52.1681263, lng: 4.4615146 },
  { id: "leiden-hague", name: "Leiden University, Campus The Hague", short: "Leiden Campus The Hague", place: "Wijnhaven", city: "The Hague", region: "den-haag", lat: 52.0786038, lng: 4.320287 },
  { id: "hhs", name: "The Hague University of Applied Sciences", short: "THUAS The Hague", place: "Main building", city: "The Hague", region: "den-haag", lat: 52.0671409, lng: 4.3245363 },
  { id: "inholland-rotterdam", name: "Inholland University of Applied Sciences", short: "Inholland Rotterdam", place: "Posthumalaan", city: "Rotterdam", region: "rotterdam", lat: 51.9061608, lng: 4.4947579 },
  { id: "hsleiden", name: "Leiden University of Applied Sciences", short: "Hogeschool Leiden", place: "Zernikedreef", city: "Leiden", region: "leiden", lat: 52.1671557, lng: 4.4717943 },
  { id: "driestar", name: "Driestar University of Applied Sciences", short: "Driestar", place: "Jamessingel", city: "Gouda", region: "gouda", lat: 52.0188196, lng: 4.699188 },
  // Amsterdam and Haarlem
  { id: "uva", name: "University of Amsterdam", short: "UvA", place: "Roeterseiland", city: "Amsterdam", region: "amsterdam", lat: 52.3629328, lng: 4.9119698 },
  { id: "uva-sp", name: "University of Amsterdam, Science Park", short: "UvA Science Park", place: "Science Park 904", city: "Amsterdam", region: "amsterdam", lat: 52.3544178, lng: 4.955694 },
  { id: "vu", name: "Vrije Universiteit Amsterdam", short: "VU Amsterdam", place: "Main building", city: "Amsterdam", region: "amsterdam", lat: 52.3345915, lng: 4.8664765 },
  { id: "hva", name: "Amsterdam University of Applied Sciences", short: "HvA", place: "Wibauthuis", city: "Amsterdam", region: "amsterdam", lat: 52.3591615, lng: 4.9096452 },
  { id: "inholland-amsterdam", name: "Inholland University of Applied Sciences", short: "Inholland Amsterdam", place: "Diemen campus", city: "Diemen", region: "amsterdam", lat: 52.3273978, lng: 4.9632343 },
  { id: "inholland-haarlem", name: "Inholland University of Applied Sciences", short: "Inholland Haarlem", place: "Bijdorplaan", city: "Haarlem", region: "haarlem", lat: 52.3891517, lng: 4.6112127 },
  // Utrecht
  { id: "uu", name: "Utrecht University", short: "Utrecht University", place: "Utrecht Science Park", city: "Utrecht", region: "utrecht", lat: 52.0851807, lng: 5.1754514 },
  { id: "uu-centre", name: "Utrecht University, City Centre", short: "UU City Centre", place: "Academiegebouw", city: "Utrecht", region: "utrecht", lat: 52.0902439, lng: 5.1223339 },
  { id: "hu", name: "HU University of Applied Sciences Utrecht", short: "HU Utrecht", place: "Heidelberglaan 15", city: "Utrecht", region: "utrecht", lat: 52.0844931, lng: 5.1757405 },
  { id: "hku", name: "HKU University of the Arts Utrecht", short: "HKU", place: "Lange Viestraat", city: "Utrecht", region: "utrecht", lat: 52.0931275, lng: 5.1158321 },
  // North
  { id: "rug", name: "University of Groningen", short: "University of Groningen", place: "Academiegebouw", city: "Groningen", region: "groningen", lat: 53.219246, lng: 6.5631006 },
  { id: "rug-zernike", name: "University of Groningen, Zernike Campus", short: "RUG Zernike", place: "Nijenborgh", city: "Groningen", region: "groningen", lat: 53.2387578, lng: 6.539544 },
  { id: "hanze", name: "Hanze University of Applied Sciences", short: "Hanze", place: "Zernikeplein", city: "Groningen", region: "groningen", lat: 53.2402347, lng: 6.5316559 },
  { id: "nhl-stenden", name: "NHL Stenden University of Applied Sciences", short: "NHL Stenden", place: "Rengerslaan", city: "Leeuwarden", region: "leeuwarden", lat: 53.2103353, lng: 5.7959713 },
  { id: "hvhl", name: "Van Hall Larenstein University of Applied Sciences", short: "Van Hall Larenstein", place: "Agora", city: "Leeuwarden", region: "leeuwarden", lat: 53.1938948, lng: 5.8035777 },
  // East
  { id: "ut", name: "University of Twente", short: "University of Twente", place: "Campus", city: "Enschede", region: "enschede", lat: 52.2398369, lng: 6.8499111 },
  { id: "saxion-enschede", name: "Saxion University of Applied Sciences", short: "Saxion Enschede", place: "Tromplaan", city: "Enschede", region: "enschede", lat: 52.2206658, lng: 6.8866567 },
  { id: "saxion-deventer", name: "Saxion University of Applied Sciences", short: "Saxion Deventer", place: "Handelskade", city: "Deventer", region: "deventer", lat: 52.2543508, lng: 6.1681875 },
  { id: "windesheim", name: "Windesheim University of Applied Sciences", short: "Windesheim", place: "Campus", city: "Zwolle", region: "zwolle", lat: 52.5001154, lng: 6.0809929 },
  { id: "wur", name: "Wageningen University & Research", short: "Wageningen University", place: "Campus", city: "Wageningen", region: "wageningen", lat: 51.986329, lng: 5.6679309 },
  { id: "che", name: "Christian University of Applied Sciences Ede", short: "CHE Ede", place: "Oude Kerkweg", city: "Ede", region: "ede", lat: 52.0195503, lng: 5.6637249 },
  { id: "ru", name: "Radboud University", short: "Radboud", place: "Heyendaal campus", city: "Nijmegen", region: "nijmegen", lat: 51.8238273, lng: 5.8679636 },
  { id: "han-nijmegen", name: "HAN University of Applied Sciences", short: "HAN Nijmegen", place: "Kapittelweg", city: "Nijmegen", region: "nijmegen", lat: 51.8260996, lng: 5.864018 },
  { id: "han-arnhem", name: "HAN University of Applied Sciences", short: "HAN Arnhem", place: "Ruitenberglaan", city: "Arnhem", region: "arnhem", lat: 51.9879272, lng: 5.9500974 },
  // South
  { id: "tue", name: "Eindhoven University of Technology", short: "TU/e", place: "Atlas", city: "Eindhoven", region: "eindhoven", lat: 51.4475445, lng: 5.4874676 },
  { id: "fontys-eindhoven", name: "Fontys University of Applied Sciences", short: "Fontys Eindhoven", place: "Rachelsmolen", city: "Eindhoven", region: "eindhoven", lat: 51.4511664, lng: 5.4795976 },
  { id: "tiu", name: "Tilburg University", short: "Tilburg University", place: "Campus", city: "Tilburg", region: "tilburg", lat: 51.5628922, lng: 5.0417568 },
  { id: "fontys-tilburg", name: "Fontys University of Applied Sciences", short: "Fontys Tilburg", place: "Professor Goossenslaan", city: "Tilburg", region: "tilburg", lat: 51.5387719, lng: 5.0770739 },
  { id: "avans-breda", name: "Avans University of Applied Sciences", short: "Avans Breda", place: "Hogeschoollaan", city: "Breda", region: "breda", lat: 51.5837013, lng: 4.797106 },
  { id: "buas", name: "Breda University of Applied Sciences", short: "BUas", place: "Mgr. Hopmansstraat", city: "Breda", region: "breda", lat: 51.5901902, lng: 4.7942688 },
  { id: "avans-denbosch", name: "Avans University of Applied Sciences", short: "Avans Den Bosch", place: "Onderwijsboulevard", city: "'s-Hertogenbosch", region: "den-bosch", lat: 51.6886358, lng: 5.2870897 },
  { id: "has", name: "HAS green academy", short: "HAS green academy", place: "Onderwijsboulevard", city: "'s-Hertogenbosch", region: "den-bosch", lat: 51.6864298, lng: 5.2859665 },
  { id: "um", name: "Maastricht University", short: "Maastricht University", place: "Inner city", city: "Maastricht", region: "maastricht", lat: 50.8471289, lng: 5.6864175 },
  { id: "um-randwyck", name: "Maastricht University, Randwyck", short: "UM Randwyck", place: "Universiteitssingel", city: "Maastricht", region: "maastricht", lat: 50.8368695, lng: 5.7164662 },
  { id: "zuyd-maastricht", name: "Zuyd University of Applied Sciences", short: "Zuyd Maastricht", place: "Brusselseweg", city: "Maastricht", region: "maastricht", lat: 50.8541241, lng: 5.6718876 },
  { id: "zuyd-heerlen", name: "Zuyd University of Applied Sciences", short: "Zuyd Heerlen", place: "Nieuw Eyckholt", city: "Heerlen", region: "heerlen", lat: 50.8810311, lng: 5.9587601 },
  { id: "hz", name: "HZ University of Applied Sciences", short: "HZ Vlissingen", place: "Edisonweg", city: "Vlissingen", region: "vlissingen", lat: 51.4498629, lng: 3.5886688 },
] as const satisfies readonly University[];

export type UniversityId = (typeof UNIVERSITIES)[number]["id"];

export const DEFAULT_UNIVERSITY: UniversityId = "tud";

export function universityById(id: string): University {
  return UNIVERSITIES.find((u) => u.id === id) ?? UNIVERSITIES[0];
}

export function studentCityById(id: string): StudentCity | undefined {
  return STUDENT_CITIES.find((c) => c.id === id);
}

const norm = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** The student city a source's city name refers to, if any. */
export function studentCityForName(name: string | null | undefined): StudentCity | undefined {
  if (!name) return undefined;
  const n = norm(name);
  return STUDENT_CITIES.find((c) => (c.aliases as readonly string[]).includes(n));
}

/** Great-circle distance in km. */
export function distanceKmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Mainland Netherlands with a little margin. */
export const NL_BOUNDS = { south: 50.7, west: 3.3, north: 53.6, east: 7.25 } as const;
export function inNetherlands(lat: unknown, lng: unknown) {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= NL_BOUNDS.south && lat <= NL_BOUNDS.north && lng >= NL_BOUNDS.west && lng <= NL_BOUNDS.east;
}

/**
 * The site loads homes one region at a time: a box reaching this far (north/south/east/west) from
 * the centre of the university's student city. Alerts use the same box, so an alert never points
 * to a home the page would not show.
 */
export const REGION_RADIUS_KM = 20;

export interface RegionBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function regionBox(region: string, radiusKm = REGION_RADIUS_KM): RegionBox {
  const city = studentCityById(region) ?? STUDENT_CITIES[0];
  const dLat = radiusKm / 111.2;
  const dLng = radiusKm / (111.2 * Math.cos((city.lat * Math.PI) / 180));
  return { south: city.lat - dLat, north: city.lat + dLat, west: city.lng - dLng, east: city.lng + dLng };
}

export function inRegionBox(box: RegionBox, lat: number | null | undefined, lng: number | null | undefined) {
  return typeof lat === "number" && typeof lng === "number" &&
    lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east;
}
