import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { StorePg } from '../core/store-pg.mjs';
import { publicListingData } from '../core/public-data.mjs';
import { storeKind } from '../core/open-store.mjs';

function mockSql(steps) {
  const sql = async (strings, ...parameters) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    assert.ok(steps.length, text);
    const [pattern, rows, check] = steps.shift();
    assert.match(text, pattern);
    check?.(parameters);
    return rows;
  };
  sql.json = (value) => JSON.parse(JSON.stringify(value));
  let transactions = 0;
  sql.begin = async (fn) => {
    transactions++;
    return fn(sql);
  };
  sql.end = async ({ timeout }) => assert.equal(timeout, 2);
  return { sql, done: (expected = 0) => {
    assert.equal(steps.length, 0);
    assert.equal(transactions, expected);
  } };
}

const ad = {
  id: 'fixture-pg-rental', source: 'kamernet', source_id: 'fixture', title: 'Fixture studio',
  city: 'Delft', url: 'https://example.invalid/rental',
  body: 'Studio in Delft. Contact: fixture@example.invalid\nPets allowed.',
  rent_base: 850, owner_review: { note: 'Private fixture' },
};

test('Postgres store persists, deduplicates and projects listing writes within a transaction', async () => {
  let raw;
  const { sql, done } = mockSql([
    [/pg_advisory_xact_lock/, []],
    [/WHERE identity = \? FOR UPDATE/, [], ([identity]) => assert.equal(identity, 'kamernet:fixture')],
    [/WHERE source_url = \?/, [{ id: 'fixture-parent' }]],
    [/INSERT INTO public.sources/, []],
    [/INSERT INTO public.listings/, [], ([id, identity, source, url, duplicate, data, safe]) => {
      assert.equal(id, ad.id);
      assert.equal(identity, 'kamernet:fixture');
      assert.equal(source, 'kamernet');
      assert.equal(duplicate, 'fixture-parent');
      assert.equal(url, ad.url);
      assert.equal(safe.rent_base, 850);
      assert.equal(safe.owner_review, undefined);
      assert.doesNotMatch(safe.body, /@/);
      raw = data;
    }],
    [/pg_advisory_xact_lock/, []],
    [/WHERE identity = \? FOR UPDATE/, [{ get data() { return raw; } }]],
    [/FROM public.listings WHERE source_id = \?/, [{ get data() { return raw; } }]],
    [/FROM public.listing_history/, [{
      listing_id: ad.id, kind: 'price', before_data: { rent_base: 900 },
      after_data: { rent_base: 850 }, changed_at: new Date('2026-02-03T00:00:00Z'),
    }]],
  ]);
  const store = new StorePg(sql);
  const first = await store.upsertListing(ad);
  assert.equal(first.isNew, true);
  assert.equal(first.listing.duplicate_of, 'fixture-parent');
  const repeat = await store.upsertListing(ad);
  assert.equal(repeat.isNew, false);
  assert.equal(repeat.isChanged, false);
  assert.equal((await store.getListings('kamernet'))[0].id, ad.id);
  assert.deepEqual(await store.getListingHistory(), [{
    listingId: ad.id, kind: 'price', before: { rent_base: 900 }, after: { rent_base: 850 }, changedAt: '2026-02-03T00:00:00.000Z',
  }]);
  await store.close();
  done(2);
});

test('Postgres store separates private travel data, run records and atomic cooldown claims', async () => {
  const record = {
    key: 'fixture-address-key', expires: 100,
    result: {
      origin: { lat: 52, lon: 4.35, precision: 'street', label: 'Fixture label' },
      destinations: [{ kind: 'campus', name: 'TU Delft Aula', lat: 52, lon: 4.36,
        routes: { bike: { status: 'ok', seconds: 180, segments: [[52, 4.36]] } } }],
      status: 'checked',
    },
  };
  let runId;
  const { sql, done } = mockSql([
    [/FROM public.settings/, [], ([key]) => assert.equal(key, 'discovery.enabled')],
    [/INSERT INTO public.travel_cache/, [], ([id, data, projection]) => {
      assert.equal(id, ad.id);
      assert.deepEqual(data, record);
      assert.equal(projection.result.origin.label, undefined);
      assert.deepEqual(projection.result.destinations[0].routes.bike, { status: 'ok', seconds: 180 });
    }],
    [/INSERT INTO public.travel_cache/, [], ([,, projection]) => assert.equal(projection, null)],
    [/DELETE FROM public.travel_cache/, []],
    [/INSERT INTO public.amenities/, []],
    [/INSERT INTO public.collector_runs/, [], ([id]) => { runId = id; }],
    [/UPDATE public.collector_runs/, [], (values) => assert.deepEqual(values, [2, 1, 3, null, runId])],
    [/max\(finished_at\)/, [{ finished: new Date('2026-02-04T00:00:00Z') }]],
    [/ON CONFLICT \(key\).*settings.data::bigint <= \? RETURNING/, [{ key: 'travel.cooldown.' + ad.id }],
      ([key, at, before]) => assert.deepEqual([key, at, before], ['travel.cooldown.' + ad.id, 2000, 1000])],
    [/ON CONFLICT \(key\).*settings.data::bigint <= \? RETURNING/, []],
    [/prune_history\(\?::interval\)/, [{ removed: '4' }]],
  ]);
  const store = new StorePg(sql);
  assert.equal(await store.getConfig('discovery.enabled', true), true);
  await store.setConfig('travel.listing.' + ad.id, record);
  await store.setConfig('travel.listing.' + ad.id, { ...record, manual: { query: 'Private fixture' } });
  await store.setConfig('travel.listing.' + ad.id, null);
  await store.setConfig('travel.catalog.v1', { places: [] });
  const id = await store.startCollectorRun();
  await store.finishCollectorRun(id, { checked: 2, added: 1, changed: 3 });
  assert.equal(await store.latestCollectorRun(), '2026-02-04T00:00:00.000Z');
  assert.equal(await store.claimTravelCheck(ad.id, 2000, 1000), true);
  assert.equal(await store.claimTravelCheck(ad.id, 2001, 1000), false);
  assert.equal(await store.pruneHistory(), 4);
  done();
});

test('defaults to SQLite and rejects an invalid backend choice', () => {
  assert.equal(storeKind({}), 'sqlite');
  assert.equal(storeKind({ HOUSEWATCH_STORE: 'supabase' }), 'supabase');
  assert.throws(() => storeKind({ HOUSEWATCH_STORE: 'other' }), /HOUSEWATCH_STORE/);
});

test('Supabase feed uses the public views through an anon client', async (t) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = key;
    globalThis.fetch = originalFetch;
  });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_ANON_KEY = 'fixture-anon-key';
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export%20{}', shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  let readSupabaseListings;
  try {
    ({ readSupabaseListings } = await import('../lib/server/supabase-feed.ts'));
  } finally {
    hook.deregister();
  }
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const route = new URL(input).pathname;
    requests.push(route);
    assert.equal(new Headers(init.headers).get('apikey'), 'fixture-anon-key');
    if (route === '/rest/v1/public_feed_status') return Response.json({ finished_at: '2026-02-05T00:00:00+00:00' });
    assert.equal(route, '/rest/v1/public_listings');
    return Response.json([{
      id: ad.id, history: [], travel: null,
      data: publicListingData({ ...ad, created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' }),
    }]);
  };
  const result = await readSupabaseListings();
  assert.deepEqual(requests, ['/rest/v1/public_feed_status', '/rest/v1/public_listings']);
  assert.equal(result.source, 'live');
  assert.equal(result.updatedAt, '2026-02-05T00:00:00.000Z');
  assert.equal(result.listings[0].costs.rent, 850);
});
