import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCollector, travelBudget } from '../core/collector.mjs';
import { runPublicDiscovery } from '../core/discovery.mjs';
import { Store } from '../core/store.mjs';

test('discovery awaits an asynchronous store and queues only new or moved ads', async (t) => {
  const sqlite = new Store(':memory:');
  t.after(() => sqlite.close());
  const store = Object.fromEntries(['getConfig', 'setConfig', 'getListings', 'upsertListing', 'updateListing', 'enqueueNotification', 'addEvent']
    .map((method) => [method, async (...args) => sqlite[method](...args)]));
  const source = {
    id: 'bjornd', kind: 'agent', origin: 'https://example.invalid', indexes: ['/index'],
    detail: /^\/listing\//, description: 'fixture-description', contact: 'Fixture contact policy.',
  };
  const description = 'A furnished studio in Delft with its own kitchen and shower. Registration is possible. The apartment comes with a storage cupboard and a private entrance.';
  const collect = (address, stamp, price = 850) => runPublicDiscovery(store, {
    sources: [source], now: Date.parse('2026-11-01') + stamp * 300_000, force: true,
    fetchSource: async (_source, url) => url.endsWith('/index')
      ? JSON.stringify([{ isRentals: true, city: 'Delft', status: 'available', address,
        url: '/listing/fixture', price: `€${price}`, changed: stamp }])
      : `<h1>Fixture studio in Delft</h1><div class="fixture-description">${description}</div>`,
  });
  const first = await collect('Fixture Street', 1);
  const id = first.travelIds[0];
  assert.ok(id);
  assert.equal(first.added, 1);
  const moved = await collect('Second Fixture Street', 2);
  assert.equal(moved.changed, 1);
  assert.deepEqual(moved.travelIds, [id]);
  const changedPrice = await collect('Second Fixture Street', 3, 825);
  assert.equal(changedPrice.changed, 1);
  assert.deepEqual(changedPrice.travelIds, []);
});

test('collector records freshness, carries excess travel work and treats webhook failure as nonfatal', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ids = ['fixture-first', 'fixture-second'];
  for (const id of ids) store.upsertListing({ id, source: 'kamernet', source_id: id, city: 'Delft', address: 'Fixture Street' });
  const called = [];
  const options = {
    budget: () => 1,
    makeTravel: () => ({
      display: async () => ({ status: 'ready' }),
      check: async (listing) => { called.push(listing.id); return { status: 'checked', checkedAt: '2026-02-01T00:00:00Z' }; },
    }),
    revalidateUrl: 'https://example.invalid/revalidate', revalidateToken: 'fixture-token',
    fetcher: async (_url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer fixture-token');
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(store.latestCollectorRun(), 'finish must precede notification');
      return Response.json({}, { status: 503 });
    },
  };
  const first = await runCollector(store, { ...options, discover: async () => ({ checked: 1, added: 2, changed: 0, travelIds: ids }) });
  assert.deepEqual(called, ids.slice(0, 1));
  assert.equal(first.revalidated, false);
  assert.equal(first.travelUpdated, 1);
  const second = await runCollector(store, { ...options, discover: async () => ({ checked: 1, added: 0, changed: 0, travelIds: [] }) });
  assert.deepEqual(called, ids);
  assert.equal(second.travelUpdated, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM collector_runs WHERE error IS NULL').get().count, 2);
});

test('fatal collector errors are recorded and a persistent travel claim lasts for the cooldown', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  await assert.rejects(runCollector(store, { discover: async () => { throw new Error('fixture failure'); } }), /fixture failure/);
  assert.equal(store.db.prepare('SELECT error FROM collector_runs').get().error, 'Collection interrupted.');
  assert.equal(store.claimTravelCheck('fixture-id', 1000, 500), true);
  assert.equal(store.claimTravelCheck('fixture-id', 1499, 500), false);
  assert.equal(store.claimTravelCheck('fixture-id', 1500, 500), true);
  assert.equal(travelBudget('0'), 0);
  assert.throws(() => travelBudget('-1'));
});
