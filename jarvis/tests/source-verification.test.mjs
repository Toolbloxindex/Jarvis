import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allowedURL, createSourceFetcher, parseDetail, parseIndex, SOURCES } from '../core/discovery.mjs';
import { parseListingText } from '../core/matcher.mjs';
import { listingEligibility } from '../lib/server/listing-eligibility.ts';
import { mapStoredListings } from '../lib/server/listings-data.ts';

const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const source = (id) => SOURCES.find((entry) => entry.id === id);
const mapped = (ad) => mapStoredListings([{ ...ad, id: 'fixture', created_at: '2026-11-26T00:00:00Z' }],
  [], () => ({ status: 'ready' }), null).listings[0];

test('Kamernet retains the advertised quote, postcode precision and explicit pets preference', () => {
  const ad = parseDetail(source('kamernet'), fixture('kamernet/detail.html'), {
    url: 'https://kamernet.nl/en/for-rent/room-delft/voorbeeldstraat/room-1234567', city: 'Delft', address: 'Voorbeeldstraat',
  });
  assert.equal(ad.rent_advertised_total, 650);
  assert.equal(ad.rent_base, null);
  assert.equal(ad.rent_excludes_bills, false);
  assert.equal(ad.location.precision, 'postcode');
  assert.equal(ad.location.postcode, '2613 AB');
  assert.equal(ad.registration, null);
  assert.equal(listingEligibility(ad).pets, 'no');
  assert.equal(ad.photos.length, 1);
});

test('HousingAnywhere strips index tracking and preserves structured calendar, deposit and cost scope', () => {
  const s = source('housinganywhere');
  const url = allowedURL(s, '/room/ut123456/nl/Delft/voorbeeldstraat?page=2');
  assert.equal(url, 'https://housinganywhere.com/room/ut123456/nl/Delft/voorbeeldstraat');
  const ad = parseDetail(s, fixture('housinganywhere/detail.html'), { url, city: 'Delft' });
  assert.equal(ad.rent_base, 1795);
  assert.deepEqual(ad.monthly_costs.map(({ amount }) => amount), [160, 265]);
  assert.equal(ad.deposit, 2220);
  assert.deepEqual(ad.availability_periods, [{ start: '2027-02-15', end: '2027-12-14' }]);
  assert.equal(ad.registration, true);
  assert.equal(ad.photos.length, 1);
});

test('ROOMMATCH uses public inline privacy-safe coordinates, native rent and terms', () => {
  const s = source('roommatch');
  const index = parseIndex(s, fixture('roommatch/index.json'), s.indexes[0]);
  const ad = parseDetail(s, '', index.candidates[0]);
  assert.equal(ad.rent_base, 932.93);
  assert.equal(ad.rent_advertised_total, 1657.64);
  assert.equal(ad.monthly_costs[0].amount, 724.71);
  assert.equal(ad.location.precision, 'postcode');
  assert.equal(ad.location.lat, 52.008);
  assert.equal(ad.start_date, '2026-12-10');
  assert.equal(ad.min_stay_months, 1);
  assert.equal(ad.max_stay_months, 12);
  assert.equal(ad.photos.length, 1);
});

test('Björnd maps immediate availability, month-of-rent deposit and the PhD exception', () => {
  const s = source('bjornd');
  const ad = parseDetail(s, fixture('bjornd/detail.html'), { url: s.origin + '/nl/woningaanbod/details/fixture', city: 'Delft', address: 'Voorbeeldstraat 9 B' });
  assert.equal(ad.rent_base, 2275);
  assert.equal(ad.start_kind, 'immediate');
  const ui = mapped(ad);
  assert.equal(ui.costs.deposit, 2275);
  assert.equal(ui.tenancy.availableFrom, '2026-11-26');
  assert.equal(ui.tenancy.minMonths, 12);
  assert.equal(ui.eligibility.tenants.bsc, 'no');
  assert.equal(ui.eligibility.tenants.phd, 'yes');
  assert.equal(ui.eligibility.couples, 'yes');
  assert.equal(ui.eligibility.pets, 'no');
  assert.equal(ad.photos.length, 1);
});

test('Verra keeps structured postcode, alphanumeric address, rent and service costs', () => {
  const s = source('verra');
  const ad = parseDetail(s, fixture('verra/detail.html'), { url: s.origin + '/nl/woningaanbod/woning/delft/fixture', city: 'Delft' });
  const ui = mapped(ad);
  assert.equal(ui.location.houseNumber, '2J10');
  assert.equal(ui.location.postcode, '2624 ES');
  assert.equal(ui.costs.rent, 1695);
  assert.equal(ui.costs.serviceCosts, 55);
  assert.equal(ui.tenancy.availableFrom, '2027-02-19');
  assert.equal(ad.photos.length, 1);
});

test('Huizenbalie stays Delft-scoped, including suffixed listing URLs', () => {
  const s = source('huizenbalie');
  const index = parseIndex(s, fixture('huizenbalie/index.html'), s.origin + s.indexes[0]);
  assert.equal(index.candidates.length, 1);
  const ad = parseDetail(s, fixture('huizenbalie/detail.html'), index.candidates[0]);
  assert.equal(ad.rent_base, 1035);
  assert.equal(ad.registration, false);
  assert.equal(ad.photos.length, 1);
});

test('Funda and Pararius stop at the first forbidden response', async () => {
  for (const id of ['funda', 'pararius']) {
    const result = JSON.parse(fixture(id + '/blocked.json'));
    const s = source(id);
    const requests = [];
    const fetch = createSourceFetcher(s, { paceMs: 0, fetchImpl: async (url) => {
      requests.push(url.pathname);
      return url.pathname === '/robots.txt'
        ? new Response('User-agent: *\nDisallow:', { status: result.robotsStatus })
        : new Response('Forbidden', { status: result.status });
    } });
    await assert.rejects(fetch(s.origin + s.indexes[0]), (error) => error.status === 'blocked' && error.httpStatus === 403);
    assert.equal(requests.length, 2);
  }
});

test('text parsing retains Dutch terms without inventing a year or a separate base rent', () => {
  const ad = parseListingText('Huurprijs: € 795 incl. gas, water en elektriciteit. Beschikbaar per 1 februari. Min. 12 maanden. Contract voor onbepaalde tijd. Geen inschrijving mogelijk. Alleen studenten. Geen stellen. Huisdieren niet toegestaan.');
  assert.equal(ad.rent_total, 795);
  assert.equal(ad.rent_base, null);
  assert.equal(ad.start_date, null);
  assert.equal(ad.availability_text, '1 februari');
  assert.equal(ad.min_stay_months, 12);
  assert.equal(ad.indefinite, true);
  assert.equal(ad.registration, false);
  assert.equal(listingEligibility(ad).tenants.professional, 'no');
  assert.equal(listingEligibility(ad).couples, 'no');
  assert.equal(listingEligibility(ad).pets, 'no');
});
