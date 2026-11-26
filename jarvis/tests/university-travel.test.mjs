import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CAMPUSES, campusTravelTimes, estimateRailMinutes, estimateTransitMinutes, nearbyCampuses, nearDelftRail, parseStreetTable, streetTablePlan, streetTableURL } from '../core/university-travel.mjs';
import { createTravelService, travelDisplay } from '../core/travel.mjs';
import { publicTravelData } from '../core/public-data.mjs';
import { Store } from '../core/store.mjs';
import { listings } from '../lib/listings/data.ts';

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/travel/' + name + '.json', import.meta.url)));
const campus = (id) => CAMPUSES.find((entry) => entry.id === id);

test('maps rectangular OSRM tables with station rows, estimates rail and omits incomplete campus routes', () => {
  const destinations = [campus('tud'), campus('eur')];
  const origins = [{ lat:52.01, lon:4.36, precision:'address' }, { lat:52.03, lon:4.36, precision:'street' }];
  const plan = streetTablePlan(origins, destinations, true);
  assert.equal(streetTableURL('walk', plan).searchParams.get('sources'), '0;1;6');
  assert.equal(streetTableURL('bike', plan).searchParams.get('destinations'), '2;3;4;5');
  const mode = (kind) => parseStreetTable(fixture(kind), kind, plan);
  const times = campusTravelTimes(0, origins[0], destinations, plan, { walk: mode('walk'), bike: mode('bike') });
  // No timetable and no rail line: a general bus/tram estimate, always flagged as estimated.
  assert.deepEqual(times.tud, { walk:10, bike:4, km:1.9, transit:17, approximate:true, source:'estimated' });
  assert.deepEqual(times.eur, { walk:30, bike:15, km:19.5, transit:52, approximate:true, source:'estimated' });
  assert.equal(campusTravelTimes(1, origins[1], destinations, plan, { walk: mode('walk'), bike: mode('bike') }).eur, undefined);
  assert.throws(() => parseStreetTable({ code:'Ok',durations:[[0]] }, 'bike', plan), /Invalid OSRM/);
});

test('rail estimate chooses station and mode, and local Delft transit is unknown without MOTIS', () => {
  const access = { delft: { walk:10, bike:4 }, delftCampus: { walk:20, bike:7 } };
  assert.equal(estimateRailMinutes(campus('hhs'), access, { hagueHS:5, hagueCentraal:15 }), 24);
  assert.equal(estimateRailMinutes(campus('leiden'), access, { leiden:12 }), 50);
  assert.equal(estimateRailMinutes(campus('tud'), access, {}), null);
  assert.equal(estimateRailMinutes(campus('eur'), {}, {}), null);
});

test('travel engine batches both modes and projects campus times into the public cache', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const listing = store.upsertListing({ id:'fixture-routed', source:'kamernet', city:'Delft',
    address:'Voorbeeldstraat', location:{ lat:52.01, lng:4.36, precision:'postcode' } }).listing;
  store.setConfig('travel.catalog.delft', { places:[], expires:Date.now()+600_000,mapVersion:2 });
  const requests = [];
  const travel = createTravelService(store, { streetInterval:0, motis:'', localPlaces:'', fetcher: async (url) => {
    requests.push(url.pathname);
    const rows = url.searchParams.get('sources').split(';').length;
    const columns = url.searchParams.get('destinations').split(';').length;
    const matrix = (v) => Array.from({ length: rows }, () => Array(columns).fill(v));
    return Response.json({ code:'Ok', durations:matrix(600), distances:matrix(1800) });
  } });
  const result = await travel.check(listing, {});
  assert.equal(requests.length, 2);
  assert.ok(requests.every((path) => path.includes('/table/')));
  // Only campuses within commuting reach are routed; Groningen is not.
  const reachable = nearbyCampuses({ lat:52.01, lon:4.36 }).map(({ id }) => id);
  assert.deepEqual(Object.keys(result.travelTimes).sort(), [...reachable].sort());
  assert.ok(reachable.includes('eur') && reachable.includes('leiden') && !reachable.includes('rug'));
  assert.equal(result.travelTimes.leiden.source, 'estimated');
  const persisted = store.getConfig('travel.listing.' + listing.id);
  const projected = publicTravelData(persisted);
  assert.deepEqual(travelDisplay(listing, projected).travelTimes, result.travelTimes);
  await travel.check(listing, {});
  assert.equal(requests.length, 2);
});

test('all mock listings contain a route to every campus around Delft', () => {
  assert.equal(listings.length, 22);
  const original = ['tud', 'hhs-delft', 'inholland-delft', 'eur', 'hr', 'leiden', 'leiden-bsp', 'leiden-hague', 'hhs'];
  assert.deepEqual(CAMPUSES.slice(0, 9).map(({ id }) => id), original, 'the original campus ids stay first and stable');
  for (const listing of listings) assert.deepEqual(Object.keys(listing.travelTimes), original);
});

test('national routing: nearby campuses, Delft rail model only near Delft, general transit estimate', () => {
  const groningen = { lat: 53.2194, lon: 6.5665 };
  const nearby = nearbyCampuses(groningen).map(({ id }) => id);
  assert.deepEqual(nearby.sort(), ['hanze', 'rug', 'rug-zernike']);
  assert.equal(nearDelftRail(groningen), false);
  assert.equal(nearDelftRail({ lat: 52.01, lon: 4.36 }), true);
  // A Groningen plan has no Delft station rows.
  const plan = streetTablePlan([groningen], nearbyCampuses(groningen), nearDelftRail(groningen));
  assert.equal(plan.points.length, 4);
  assert.equal(estimateTransitMinutes(1), null);
  assert.equal(estimateTransitMinutes(5), 30);
  assert.equal(estimateTransitMinutes(30), 48);
  assert.ok(CAMPUSES.length >= 45);
  assert.equal(new Set(CAMPUSES.map(({ id }) => id)).size, CAMPUSES.length);
});

test('MOTIS supplies transit for every campus and old samples expire without dropping cycling times', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ad = store.upsertListing({ id:'fixture-motis', source:'kamernet', city:'Delft',
    address:'Voorbeeldstraat', location:{ lat:52.01, lng:4.36, precision:'exact' } }).listing;
  const now = Date.parse('2026-11-23T07:00:00Z');
  store.setConfig('travel.catalog.delft', { places:[],expires:now+600_000,mapVersion:2 });
  const reachable = nearbyCampuses({ lat:52.01, lon:4.36 });
  let motisCalls = 0;
  const service = createTravelService(store, {
    streetInterval:0, motis:'http://127.0.0.1:8080', localPlaces:'', now:()=>now,
    fetcher: async (url) => {
      if (url.hostname === '127.0.0.1') {
        motisCalls++;
        assert.equal(url.searchParams.get('time'), '2026-11-23T07:30:00.000Z');
        return Response.json(fixture('motis'));
      }
      const dimensions = [url.searchParams.get('sources'), url.searchParams.get('destinations')].map((s) => s.split(';').length);
      assert.deepEqual(dimensions, [1,reachable.length]);
      return Response.json({ code:'Ok', durations:[reachable.map(() => 600)], distances:[reachable.map(() => 1800)] });
    },
  });
  const display = await service.check(ad, {});
  assert.equal(motisCalls, reachable.length);
  assert.equal(display.travelTimes.eur.transit, 35);
  assert.equal(display.travelTimes.eur.approximate, false);
  assert.equal(display.travelTimes.eur.source, 'routed');
  const record = store.getConfig('travel.listing.' + ad.id);
  const stale = travelDisplay(ad, record, { now:()=>Date.parse('2026-11-23T08:00:00Z'),transitEnabled:true });
  assert.equal(stale.travelTimes.eur.transit, null);
  assert.equal(stale.travelTimes.eur.bike, 10);
});
