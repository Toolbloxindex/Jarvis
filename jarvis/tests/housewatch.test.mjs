import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listings as mocks } from '../lib/listings/data.ts';
import { readListings } from '../lib/server/listings-data.ts';
import { listingEligibility } from '../lib/server/listing-eligibility.ts';
import { travelDetail } from '../lib/server/listing-travel.ts';
import { openExistingStore, validListingId } from '../core/runtime.mjs';
import { Store } from '../core/store.mjs';
import { createTravelService } from '../core/travel.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'housewatch-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'housing.sqlite') };
}

const primary = {
  id: 'fixture-primary',
  source: 'kamernet',
  source_id: 'fixture-listing',
  city: 'Delft',
  title: 'Studio in Delft',
  url: 'https://example.invalid/studio',
  address: 'Example Street',
  body: 'Graduates and PhDs welcome. No pets. Registration is possible.',
  availability: 'available',
  rent_base: 850,
  rent_excludes_bills: true,
  monthly_costs: [
    { label: 'Service charge', amount: 35 },
    { label: 'Heating', amount: 20 },
    { label: 'Electricity', amount: 30 },
    { label: 'Parking', amount: 70, conditional: true },
  ],
  deposit: 1000,
  indefinite: true,
  start_date: '2027-02-01',
  min_stay_months: 12,
  registration: true,
  area_m2: 30,
  furnished: 'upholstered',
  photos: [{ url: 'https://resources.kamernet.nl/example.jpg' }],
  last_seen_at: '2099-01-01T08:00:00Z',
};

test('maps a Store fixture with duplicates, history, charges and cached travel', (t) => {
  const { path } = fixture(t);
  const store = new Store(path);
  try {
    const first = store.upsertListing(primary).listing;
    const duplicate = store.upsertListing({
      ...primary, source: 'pararius', id: 'fixture-duplicate', rent_base: 925,
      deposit: null, registration: false, last_seen_at: '2099-01-01T10:00:00Z',
      photos: [{ url: 'https://images.pararius.com/example.jpg' }],
      extraction_warnings: ['The structured utility label and the description disagree.'],
    }).listing;
    assert.equal(duplicate.duplicate_of, first.id);
    assert.equal(store.upsertListing(primary).isChanged, false);
    store.upsertListing({ ...primary, rent_base: 800, start_date: '2027-03-01' });
    store.updateListing(first.id, { last_seen_at: '2099-01-01T09:00:00Z' });
    store.updateListing(first.id, { availability: 'unavailable' });
    store.updateListing(first.id, { availability: 'available' });
    store.upsertListing({ ...primary, id: 'fixture-other', source_id: 'other', city: 'Rijswijk', address: null });
    store.upsertListing({ ...primary, id: 'fixture-lead', source_id: 'lead', listing_kind: 'general_lead' });
    store.setConfig('travel.listing.' + first.id, {
      key: createHash('sha256').update('examplestreetdelft').digest('hex'),
      expires: Date.parse('2099-01-02'),
      result: {
        status: 'checked', mapVersion: 2, transitEnabled: true, checkedAt: '2099-01-01T09:00:00Z',
        sampleDeparture: '2099-01-02T08:30:00Z',
        origin: { lat: 52.01, lon: 4.36, precision: 'street' },
        destinations: [
          { kind: 'campus', name: 'TU Delft Aula', lat: 52.00219, lon: 4.37347, routes: { transit: { status: 'ok', seconds: 990 } } },
          { kind: 'supermarket', name: 'Fixture supermarket', lat: 52.01, lon: 4.35, routes: { walk: { status: 'ok', seconds: 300 } } },
          { kind: 'gym', name: 'Fixture gym', lat: 52.012, lon: 4.36, routes: { bike: { status: 'ok', seconds: 180 } } },
        ],
      },
    });
  } finally {
    store.close();
  }

  const result = readListings(path);
  assert.equal(result.source, 'live');
  assert.equal(result.updatedAt, '2099-01-01T10:00:00Z');
  assert.equal(result.listings.length, 1);
  const [listing] = result.listings;
  assert.equal(listing.id, 'fixture-primary');
  assert.equal(listing.title, 'Example Street');
  assert.equal(listing.kind, 'studio');
  assert.equal(listing.registration, 'yes');
  assert.equal(listing.sizeM2, 30);
  assert.equal(listing.furnishing, 'upholstered');
  assert.deepEqual(listing.costs, {
    rent: 800, serviceCosts: 35, utilities: 50, billsIncluded: false, deposit: 1000, previousRent: 850,
  });
  assert.deepEqual(listing.tenancy, { availableFrom: '2027-03-01', minMonths: 12, maxMonths: 'indefinite' });
  assert.equal(listing.eligibility.tenants.phd, 'yes');
  assert.equal(listing.eligibility.pets, 'no');
  assert.equal(listing.transitToAula, 17);
  assert.deepEqual(listing.location, {
    lat: 52.01, lng: 4.36, precision: 'street', street: 'Example Street', postcode: '', neighbourhood: '',
  });
  assert.equal(listing.nearestSupermarket.name, 'Fixture supermarket');
  assert.equal(listing.nearestGym.lng, 4.36);
  assert.deepEqual(listing.photos.map(({ src }) => src), [
    'https://resources.kamernet.nl/example.jpg', 'https://images.pararius.com/example.jpg',
  ]);
  assert.deepEqual(listing.sources.map(({ name, url, rent, lastCheckedAt }) => [name, url, rent, lastCheckedAt]), [
    ['Kamernet', 'https://example.invalid/studio', 800, '2099-01-01T09:00:00Z'],
    ['Pararius', 'https://example.invalid/studio', 925, '2099-01-01T10:00:00Z'],
  ]);
  assert.deepEqual(listing.history.map(({ kind }) => kind), ['listed', 'duplicate', 'price', 'availability', 'availability', 'relisted']);
  assert.equal(listing.history[0].rent, 850);
  assert.ok(listing.flags.some(({ kind, field }) => kind === 'conflict' && field === 'price'));
  assert.ok(listing.flags.some(({ kind, field }) => kind === 'conflict' && field === 'registration'));
  assert.ok(listing.flags.some(({ kind, field }) => kind === 'conflict' && field === 'bills'));
});

test('keeps missing fields unknown and reads a legacy database without migrating it', (t) => {
  const { directory, path } = fixture(t);
  const store = new Store(path);
  try {
    store.upsertListing({
      id: 'fixture-sparse', source: 'roommatch', city: 'Delft', rent_advertised_total: 650,
      start_month: '2027-02', url: 'https://example.invalid/rental',
    });
    store.db.exec('DROP TRIGGER record_listing_history; DROP TABLE listing_history;');
  } finally {
    store.close();
  }
  const before = statSync(path).mtimeMs;
  const mode = statSync(directory).mode;
  const reader = openExistingStore(path);
  try {
    assert.throws(() => reader.setConfig('fixture.write', true), /readonly/i);
  } finally {
    reader.close();
  }
  const result = readListings(path);
  const [listing] = result.listings;
  assert.equal(result.source, 'live');
  assert.equal(listing.history.length, 1);
  assert.equal(listing.advertisedRent, 650);
  assert.equal(listing.costs.rent, null);
  assert.equal(listing.costs.billsIncluded, null);
  assert.equal(listing.tenancy.availableFrom, null);
  assert.equal(listing.location.precision, null);
  assert.equal(listing.location.lat, null);
  assert.equal(listing.transitToAula, null);
  assert.equal('nearestSupermarket' in listing, false);
  assert.equal('nearestGym' in listing, false);
  assert.equal(statSync(path).mtimeMs, before);
  assert.equal(statSync(directory).mode, mode);
});

test('falls back for missing, uninitialized, empty and non-Delft databases', (t) => {
  const { directory, path } = fixture(t);
  const expectMock = (candidate) => assert.deepEqual(readListings(candidate), { listings: mocks, source: 'mock', updatedAt: null });
  expectMock(path);
  assert.equal(existsSync(path), false);
  const zeroByte = join(directory, 'empty.sqlite');
  writeFileSync(zeroByte, '');
  expectMock(zeroByte);
  const store = new Store(path);
  try {
    expectMock(path);
    store.upsertListing({ ...primary, city: 'Rotterdam' });
    expectMock(path);
    store.upsertListing({ ...primary, source_id: 'lead', id: 'only-lead', listing_kind: 'general_lead' });
    expectMock(path);
  } finally {
    store.close();
  }
});

test('derives eligibility from explicit text and native applicant fields', () => {
  assert.deepEqual(
    listingEligibility({ restrictions: ['Students only', 'No couples', 'No pets'] }),
    { tenants: { bsc: 'yes', msc: 'yes', phd: 'unknown', professional: 'no' }, couples: 'no', pets: 'no', basis: 'text' },
  );
  assert.deepEqual(
    listingEligibility({ body: 'Graduates and PhDs welcome. Pets allowed on request.' }),
    { tenants: { bsc: 'unknown', msc: 'yes', phd: 'yes', professional: 'unknown' }, couples: 'unknown', pets: 'unknown', basis: 'text' },
  );
  assert.deepEqual(
    listingEligibility({ student_allowed: true, evidence: { student_allowed: 'HousingAnywhere tenant type: students and working professionals.' }, source_preferences: { tenants: 1 }, pets_allowed: true }),
    { tenants: { bsc: 'yes', msc: 'yes', phd: 'unknown', professional: 'yes' }, couples: 'no', pets: 'yes', basis: 'structured' },
  );
  assert.equal(listingEligibility({ body: 'Working professionals only.' }).tenants.bsc, 'no');
  assert.deepEqual(listingEligibility({ body: 'PhD students only.' }).tenants,
    { bsc: 'no', msc: 'no', phd: 'yes', professional: 'no' });
  assert.deepEqual(listingEligibility({ body: 'Only MSc or PhD students.' }).tenants,
    { bsc: 'no', msc: 'yes', phd: 'yes', professional: 'no' });
  assert.equal(listingEligibility({ body: 'The current occupants are PhD students.' }).tenants.phd, 'unknown');
  assert.equal(listingEligibility({ body: 'Students only.', extraction_warnings: ['The HousingAnywhere tenant type and description differ on whether students are accepted.'] }).tenants.bsc, 'unknown');
  for (const listing of mocks) {
    assert.deepEqual(listing.eligibility, listingEligibility({ body: listing.description, restrictions: listing.restrictions }), listing.id);
  }
});

test('travel uses only the addressed listing and preserves partial cached routes', async (t) => {
  const { path } = fixture(t);
  const store = new Store(path);
  t.after(() => store.close());
  const listing = store.upsertListing(primary).listing;
  const second = store.upsertListing({ ...primary, id: 'fixture-second', source_id: 'second', address: 'Other Street' }).listing;
  const attempted = [];
  const service = createTravelService(store, {
    fetcher: async (url) => {
      attempted.push(url.hostname);
      if (url.hostname === 'api.pdok.nl') {
        return Response.json({ response: { docs: [{ straatnaam: 'Example Street', woonplaatsnaam: 'Delft', centroide_ll: 'POINT(4.36 52.01)' }] } });
      }
      throw new Error('Fixture provider unavailable');
    },
    streetInterval: 0,
    motis: '',
    localPlaces: '',
  });
  store.setConfig('travel.catalog.v1', {
    places: [{ kind: 'gym', name: 'Fixture gym', lat: 52.009, lon: 4.37 }],
    expires: Date.parse('2099-01-02'), mapVersion: 2,
  });
  assert.equal(travelDetail(service.display(listing)).status, 'ready');
  assert.deepEqual(attempted, []);
  const [first, concurrent] = await Promise.all([service.check(listing, {}), service.check(listing, {})]);
  const result = travelDetail(first);
  assert.deepEqual(first, concurrent);
  assert.equal(attempted.filter((host) => host === 'api.pdok.nl').length, 1);
  assert.equal(result.status, 'provider_unavailable');
  assert.equal(result.approximate, true);
  assert.deepEqual(result.aula, { walk: null, bike: null, transit: null });
  assert.equal(result.nearestGym?.name, 'Fixture gym');
  assert.ok(store.getConfig('travel.listing.' + listing.id));
  assert.equal(store.getConfig('travel.listing.' + second.id), null);
  assert.deepEqual(await service.check(listing, {}), first);
  assert.equal(attempted.filter((host) => host === 'api.pdok.nl').length, 1);
  assert.equal(validListingId('../bad'), false);
  assert.equal(validListingId(listing.id), true);
});
