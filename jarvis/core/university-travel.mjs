import { UNIVERSITIES, DEFAULT_UNIVERSITY } from '../lib/universities.ts';

export const CAMPUSES = UNIVERSITIES.map(({ id, short, place, city, lat, lng }) =>
  ({ id, kind: 'campus', name: id === DEFAULT_UNIVERSITY ? short + ' ' + place : short, city, lat, lon: lng }));
export const DEFAULT_CAMPUS = CAMPUSES.find(({ id }) => id === DEFAULT_UNIVERSITY);

const metres = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h)));
};

/** Campuses routed from a home: those a student could plausibly commute to (straight line). */
export const ROUTE_REACH_M = 40_000;
export function nearbyCampuses(origin, reach = ROUTE_REACH_M) {
  return CAMPUSES.filter((campus) => metres(origin, campus) <= reach);
}

/** The Delft rail model below only applies to homes around Delft's two stations. */
export function nearDelftRail(origin) {
  return metres(origin, RAIL_STATIONS.delft) <= 12_000;
}

/**
 * Door-to-door public transport estimate where no timetable route or rail model exists.
 * Short trips: bus/tram at ~14 km/h plus walking and waiting. Longer ones: train at ~60 km/h
 * plus ~18 minutes to get to, wait at and leave the stations. Always marked as an estimate.
 */
export function estimateTransitMinutes(km) {
  if (!Number.isFinite(km) || km < 0) return null;
  if (km <= 1.2) return null; // walking distance: transit adds nothing
  const local = km / 14 * 60 + 9;
  const rail = km / 60 * 60 + 18;
  return Math.round(km <= 8 ? local : Math.min(local, rail));
}

// Representative weekday, off-peak planning inputs. NS departure boards (Delft and Delft Campus)
// establish stops and frequencies: https://assets.travelsupport-p.cla.ns.nl/stations/vertrekstaten/DT-2.pdf
// NS publishes typical journey times for Delft–Leiden (24 min) and Delft–Den Haag HS (8 min):
// https://www.ns.nl/trajecten/delft-naar-leiden and https://www.ns.nl/trajecten/delft-naar-den-haag-hs
// Other ride times and headways are rounded planning assumptions, not a live or guaranteed timetable.
export const RAIL_STATIONS = {
  delft: { lat: 52.0067, lon: 4.3566 },
  delftCampus: { lat: 51.9906, lon: 4.3655 },
  rotterdam: { lat: 51.9244, lon: 4.4694 },
  hagueHS: { lat: 52.0696, lon: 4.3212 },
  hagueCentraal: { lat: 52.0809, lon: 4.3244 },
  leiden: { lat: 52.1661, lon: 4.4823 },
};

const arrivals = {
  Rotterdam: ['rotterdam'],
  'The Hague': ['hagueHS', 'hagueCentraal'],
  Leiden: ['leiden'],
};
const departures = ['delft', 'delftCampus'];
// Ride minutes, off-peak headway minutes, and approximate transfer wait (Delft Campus–Leiden via Delft).
const rail = {
  delft: { rotterdam: [14, 15], hagueHS: [8, 10], hagueCentraal: [13, 15], leiden: [24, 15] },
  delftCampus: { rotterdam: [15, 15], hagueHS: [12, 15], hagueCentraal: [17, 15], leiden: [28, 15, 7.5] },
};

export function streetTablePlan(origins, destinations, estimateTransit) {
  const departurePoints = estimateTransit ? departures.map((id) => RAIL_STATIONS[id]) : [];
  const arrivalIds = estimateTransit ? [...new Set(destinations.flatMap((point) => arrivals[point.city] ?? []))] : [];
  const arrivalPoints = arrivalIds.map((id) => RAIL_STATIONS[id]);
  const points = [...origins, ...destinations, ...departurePoints, ...arrivalPoints];
  return {
    points,
    originCount: origins.length,
    destinationCount: destinations.length,
    destinations: [...destinations, ...departurePoints].map((_, index) => origins.length + index),
    sources: origins.map((_, index) => index),
    arrivalSources: Object.fromEntries(arrivalIds.map((id, index) => [id, origins.length + destinations.length + departurePoints.length + index])),
  };
}

export function streetTableURL(mode, plan) {
  const profile = { walk: 'foot', bike: 'bike' }[mode];
  if (!profile) throw new Error('Unknown street routing mode.');
  const coordinates = plan.points.map(({ lon, lat }) => [lon, lat].map((n) => n.toFixed(6)).join(',')).join(';');
  const url = new URL(`https://routing.openstreetmap.de/routed-${profile}/table/v1/driving/${coordinates}`);
  const sources = mode === 'walk' ? [...plan.sources, ...Object.values(plan.arrivalSources)] : plan.sources;
  url.search = new URLSearchParams({
    sources: sources.join(';'), destinations: plan.destinations.join(';'),
    annotations: mode === 'bike' ? 'duration,distance' : 'duration',
  });
  return url;
}

const validMetric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function parseStreetTable(data, mode, plan) {
  if (data?.code === 'NoTable' || data?.code === 'NoSegment') return { status: 'no_route' };
  const height = plan.originCount + (mode === 'walk' ? Object.keys(plan.arrivalSources).length : 0);
  const matrix = (values) => Array.isArray(values) && values.length === height &&
    values.every((row) => Array.isArray(row) && row.length === plan.destinations.length && row.every((n) => n === null || validMetric(n)));
  if (data?.code !== 'Ok' || !matrix(data.durations) || (mode === 'bike' && !matrix(data.distances))) {
    throw new Error('Invalid OSRM table response.');
  }
  return { status: 'ok', durations: data.durations, ...(mode === 'bike' ? { distances: data.distances } : {}) };
}

export function tableRoute(table, origin, destination) {
  if (table?.status !== 'ok') return { status: table?.status ?? 'unavailable' };
  const seconds = table.durations[origin]?.[destination];
  if (!validMetric(seconds)) return { status: 'no_route' };
  return { status: 'ok', seconds, metres: table.distances?.[origin]?.[destination] ?? null };
}

export function estimateRailMinutes(campus, access, lastMile) {
  const stations = arrivals[campus.city];
  if (!stations) return null;
  const choices = [];
  for (const from of departures) {
    const legs = [access[from]?.walk, access[from]?.bike].filter(validMetric);
    if (!legs.length) continue;
    // Allow two minutes to park and lock a bike before boarding.
    const firstMile = Math.min(access[from]?.walk ?? Infinity,
      validMetric(access[from]?.bike) ? access[from].bike + 2 : Infinity);
    for (const to of stations) {
      const [ride, headway, transferWait = 0] = rail[from][to];
      let finalLeg = lastMile[to];
      // RET metro via Beurs to Kralingse Zoom, including transfer and the campus' ten-minute walk.
      // https://www.eur.nl/en/campus/locations/campus-woudestein/route-directions
      if (campus.id === 'eur' && to === 'rotterdam') finalLeg = Math.min(finalLeg ?? Infinity, 25);
      if (validMetric(finalLeg)) choices.push(firstMile + ride + headway / 2 + transferWait + finalLeg);
    }
  }
  return choices.length ? Math.round(Math.min(...choices)) : null;
}

export function campusTravelTimes(originIndex, origin, destinations, plan, { walk, bike, transit }) {
  const minute = (table, row, col) => {
    const seconds = table?.durations?.[row]?.[col];
    return validMetric(seconds) ? seconds / 60 : null;
  };
  const access = Object.fromEntries(departures.map((id, index) => [id, {
    walk: minute(walk, originIndex, destinations.length + index),
    bike: minute(bike, originIndex, destinations.length + index),
  }]));
  const arrivalIds = Object.keys(plan.arrivalSources);
  return Object.fromEntries(destinations.flatMap((campus, index) => {
    if (campus.kind !== 'campus') return [];
    const walkMinutes = minute(walk, originIndex, index);
    const bikeMinutes = minute(bike, originIndex, index);
    const metres = bike?.distances?.[originIndex]?.[index];
    // The UI contract requires walking and cycling times plus cycling distance.
    if (walkMinutes === null || bikeMinutes === null || !validMetric(metres)) return [];
    const lastMile = Object.fromEntries(arrivalIds.map((id, row) => [id, minute(walk, plan.originCount + row, index)]));
    const routed = transit?.[index];
    const railMinutes = transit ? null : estimateRailMinutes(campus, access, lastMile) ??
      estimateTransitMinutes(metres / 1000);
    const transitMinutes = routed?.status === 'ok' ? Math.round(routed.seconds / 60) : railMinutes;
    return [[campus.id, {
      walk: Math.round(walkMinutes), bike: Math.round(bikeMinutes), transit: transitMinutes,
      km: Math.round(metres / 100) / 10, approximate: origin.precision !== 'address' || railMinutes !== null,
      source: railMinutes !== null ? 'estimated' : 'routed',
    }]];
  }));
}
