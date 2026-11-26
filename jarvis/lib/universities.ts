/**
 * Campuses students living in Delft commute to. Coordinates are the main building entrance,
 * geocoded from OpenStreetMap (Nominatim). Single source of truth for the UI and core/travel.
 */
export interface University {
  id: string;
  /** Full name, shown in the picker. */
  name: string;
  /** Short name for tight spaces ("to TU Delft"). */
  short: string;
  /** The building times are measured to. */
  place: string;
  city: string;
  lat: number;
  lng: number;
}

export const UNIVERSITIES = [
  { id: "tud", name: "TU Delft", short: "TU Delft", place: "Aula", city: "Delft", lat: 52.0021922, lng: 4.3734709 },
  { id: "hhs-delft", name: "The Hague University of Applied Sciences", short: "THUAS Delft", place: "Delft campus", city: "Delft", lat: 52.0016196, lng: 4.3680178 },
  { id: "inholland-delft", name: "Inholland University of Applied Sciences", short: "Inholland Delft", place: "Delft campus", city: "Delft", lat: 52.0002595, lng: 4.3688991 },
  { id: "eur", name: "Erasmus University Rotterdam", short: "Erasmus", place: "Woudestein campus", city: "Rotterdam", lat: 51.9176312, lng: 4.5259623 },
  { id: "hr", name: "Rotterdam University of Applied Sciences", short: "Hogeschool Rotterdam", place: "Museumpark", city: "Rotterdam", lat: 51.9135409, lng: 4.4691951 },
  { id: "leiden", name: "Leiden University", short: "Leiden", place: "Academiegebouw", city: "Leiden", lat: 52.1571451, lng: 4.4853784 },
  { id: "leiden-bsp", name: "Leiden University, Science Park", short: "Leiden Science Park", place: "Gorlaeus / LIACS", city: "Leiden", lat: 52.1681263, lng: 4.4615146 },
  { id: "leiden-hague", name: "Leiden University, Campus The Hague", short: "Leiden Campus The Hague", place: "Wijnhaven", city: "The Hague", lat: 52.0786038, lng: 4.320287 },
  { id: "hhs", name: "The Hague University of Applied Sciences", short: "THUAS The Hague", place: "Main building", city: "The Hague", lat: 52.0671409, lng: 4.3245363 },
] as const satisfies readonly University[];

export type UniversityId = (typeof UNIVERSITIES)[number]["id"];

export const DEFAULT_UNIVERSITY: UniversityId = "tud";

export function universityById(id: string): University {
  return UNIVERSITIES.find((u) => u.id === id) ?? UNIVERSITIES[0];
}
