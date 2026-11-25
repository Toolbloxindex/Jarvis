import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MOCK_NOW, listings as mocks } from '../lib/listings/data.ts';
import { Store } from '../core/store.mjs';

// Node's test runner has no Next.js server module resolver.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export%20{}', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { readUiAmenities, toUiFeed, toUiListing } = await import('../lib/server/to-ui-listing.ts');
hook.deregister();

const live = {
  id: 'fixture-rental',
  kind: 'studio',
  title: 'Fixture rental',
  description: 'Self-contained rental.',
  location: { lat: 52, lng: 4.35, precision: 'street', street: 'Example Street', postcode: '', neighbourhood: '' },
  sizeM2: 30,
  bedrooms: 1,
  furnishing: 'furnished',
  costs: { rent: 760, serviceCosts: 30, utilities: 80, billsIncluded: false, deposit: null },
  tenancy: { availableFrom: '2027-02-01', minMonths: null, maxMonths: 'indefinite' },
  registration: 'unknown',
  restrictions: [],
  eligibility: mocks[0].eligibility,
  features: [],
  photos: [{ src: 'https://example.invalid/fixture.jpg', alt: 'Fixture photo' }],
  sources: [],
  history: [],
  flags: [],
  listedAt: MOCK_NOW,
  transitToAula: null,
  nearestSupermarket: { name: 'Fixture supermarket', kind: 'supermarket', lat: 52.004, lng: 4.35 },
  nearestGym: { name: 'Fixture gym', kind: 'gym', lat: 52.005, lng: 4.35 },
  availability: 'available',
  advertisedRent: 790,
};

test('uses an advertised quote without adding separate costs or claiming a rent drop', () => {
  const listing = toUiListing({
    ...live,
    costs: { ...live.costs, rent: null, previousRent: 810 },
    flags: [{ id: 'source-price', field: 'price', kind: 'missing', message: 'The primary ad does not establish a separate base rent.' }],
  }, MOCK_NOW);
  assert.equal(listing.costs.rent, 790);
  assert.equal(listing.costs.serviceCosts, null);
  assert.equal(listing.costs.utilities, null);
  assert.equal('previousRent' in listing.costs, false);
  assert.deepEqual(listing.flags, [{
    id: 'source-price', field: 'price', kind: 'missing', message: 'The ad gives one monthly amount without a breakdown.',
  }]);
  assert.equal(toUiListing({ ...live, advertisedRent: null, costs: { ...live.costs, rent: null } }, MOCK_NOW), null);
});

test('uses the clock date for an unknown move-in day and adds an availability flag', () => {
  const listing = toUiListing({ ...live, tenancy: { ...live.tenancy, availableFrom: null } }, '2027-01-01T00:15:00+01:00');
  assert.equal(listing.tenancy.availableFrom, '2027-01-01');
  assert.ok(listing.flags.some((flag) => flag.field === 'availability' && flag.kind === 'missing'));
});

test('skips listings without coordinates or photos', () => {
  assert.equal(toUiListing({ ...live, location: { ...live.location, lat: null } }, MOCK_NOW), null);
  assert.equal(toUiListing({ ...live, photos: [] }, MOCK_NOW), null);
});

test('marks unknown furnishing, floor area, bedrooms, bills, price and location precision', () => {
  const listing = toUiListing({
    ...live, kind: null, description: 'Shared kitchen.', sizeM2: null, furnishing: null, bedrooms: null,
    location: { ...live.location, precision: null },
    costs: { ...live.costs, billsIncluded: null },
    sources: [{ id: 'fixture-source', name: 'Fixture platform', kind: 'platform', rent: null, url: 'https://example.invalid', lastCheckedAt: MOCK_NOW }],
  }, MOCK_NOW, { sizes: { room: 21 } });
  assert.equal(listing.kind, 'room');
  assert.equal(listing.sizeM2, 21);
  assert.equal(listing.furnishing, 'upholstered');
  assert.equal(listing.bedrooms, 1);
  assert.equal(listing.costs.billsIncluded, false);
  assert.equal(listing.sources[0].rent, live.costs.rent);
  assert.equal(listing.location.precision, 'street');
  assert.deepEqual(listing.flags.map(({ field, kind }) => [field, kind]), [
    ['bills', 'missing'], ['address', 'missing'], ['furnishing', 'missing'], ['size', 'missing'], ['size', 'missing'], ['price', 'missing'],
  ]);
  assert.equal(toUiListing({ ...live, kind: null }, MOCK_NOW).kind, 'studio');
  assert.equal(toUiListing({ ...live, kind: null, sizeM2: 50 }, MOCK_NOW).kind, 'apartment');
});

test('uses known live floor areas by kind, counts skip reasons and preserves the exact mock list', () => {
  const mock = toUiFeed({ listings: mocks, source: 'mock', updatedAt: null }, MOCK_NOW, () => {
    throw new Error('Mock feed should not read the amenities catalogue');
  });
  assert.strictEqual(mock.listings, mocks);
  assert.equal(JSON.stringify(mock.listings), JSON.stringify(mocks));

  const result = toUiFeed({
    source: 'live', updatedAt: MOCK_NOW,
    listings: [
      { ...live, sizeM2: null },
      { ...live, id: 'fixture-coordinates', sizeM2: 26, location: { ...live.location, lng: null }, photos: [] },
      { ...live, id: 'fixture-photo', sizeM2: 38, photos: [] },
      { ...live, id: 'fixture-amenities', sizeM2: null, nearestGym: undefined },
      { ...live, id: 'fixture-rent', sizeM2: null, advertisedRent: null, costs: { ...live.costs, rent: null } },
    ],
  }, MOCK_NOW, () => []);
  assert.equal(result.source, 'live');
  assert.deepEqual(result.skipped, { noCoordinates: 1, noRent: 1, awaitingTravelData: 1, noPhotos: 2 });
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].sizeM2, 32);
});

test('uses cached listing amenities first, then nearest places from the local file and shared cache', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'housewatch-ui-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'housing.sqlite');
  const file = join(directory, 'amenities.json');
  const previous = process.env.HOUSEWATCH_AMENITIES_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.HOUSEWATCH_AMENITIES_FILE;
    else process.env.HOUSEWATCH_AMENITIES_FILE = previous;
  });
  process.env.HOUSEWATCH_AMENITIES_FILE = file;
  writeFileSync(file, JSON.stringify({
    elements: [
      { lat: 52.02, lon: 4.35, tags: { shop: 'supermarket', name: 'Lidl' } },
      { lat: 52.001, lon: 4.35, tags: { shop: 'supermarket', name: 'Jumbo' } },
    ],
  }));
  const store = new Store(path);
  try {
    store.setConfig('travel.catalog.v1', { places: [{ kind: 'gym', name: 'Cached gym', lat: 52.002, lon: 4.35 }] });
  } finally {
    store.close();
  }

  const item = { ...live, nearestGym: undefined, nearestSupermarket: undefined };
  const result = toUiFeed({ listings: [item, { ...item, nearestSupermarket: live.nearestSupermarket }], source: 'live', updatedAt: null },
    MOCK_NOW, () => readUiAmenities(path));
  assert.equal(result.listings[0].nearestSupermarket.name, 'Jumbo');
  assert.equal(result.listings[0].nearestGym.name, 'Cached gym');
  assert.deepEqual(result.listings[1].nearestSupermarket, live.nearestSupermarket);
  assert.equal(result.skipped.awaitingTravelData, 0);
});
