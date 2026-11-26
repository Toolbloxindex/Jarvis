import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  ALERT_RADIUS_KM, digestEmail, findMatches, loadMatchingLib, medianPerM2, pushPayload, unsubscribeSig, unsubscribeUrl,
} from '../core/notify.mjs';
import { MOCK_NOW, listings } from '../lib/listings/data.ts';
import { stamp } from '../lib/sync.ts';

const lib = await loadMatchingLib();
const perM2 = medianPerM2(lib, listings);
const before = Date.parse('2000-01-01T00:00:00Z');
const docWith = (search, extra = {}) => {
  let doc = stamp({}, 'search', search, 10);
  for (const [k, v] of Object.entries(extra)) doc = stamp(doc, k, v, 10);
  return doc;
};
const wide = { university: 'tud', moveIn: null, moveInFlexDays: 14, moveOut: null, moveOutFlexDays: 30, budget: null };

test('matches use the synced search and the app matching code', () => {
  const all = findMatches({ lib, listings, doc: docWith(wide), since: before, nowIso: MOCK_NOW, perM2 });
  assert.ok(all.views.length > 0);
  assert.equal(all.university.id, 'tud');
  for (const v of all.views) {
    assert.notEqual(v.status, 'outside');
    assert.ok(v.travel.km <= ALERT_RADIUS_KM);
  }
  const tight = findMatches({ lib, listings, doc: docWith({ ...wide, budget: 600 }), since: before, nowIso: MOCK_NOW, perM2 });
  assert.ok(tight.views.length < all.views.length, 'a lower budget matches fewer homes');
  assert.ok(tight.views.every((v) => v.total <= 600 * 1.1));
});

test('only homes first seen after the cursor count', () => {
  const sorted = [...listings].sort((a, b) => Date.parse(a.listedAt) - Date.parse(b.listedAt));
  const cut = Date.parse(sorted[Math.floor(sorted.length / 2)].listedAt);
  const { views } = findMatches({ lib, listings, doc: docWith(wide), since: cut, nowIso: MOCK_NOW, perM2 });
  assert.ok(views.every((v) => Date.parse(v.listing.listedAt) > cut));
});

test('saved and passed homes are never alerted; filters apply', () => {
  const base = findMatches({ lib, listings, doc: docWith(wide), since: before, nowIso: MOCK_NOW, perM2 }).views;
  const [first, second] = base.map((v) => v.listing.id);
  const without = findMatches({ lib, listings, doc: docWith(wide, { saved: [first], passed: [second] }), since: before, nowIso: MOCK_NOW, perM2 });
  assert.ok(!without.views.some((v) => [first, second].includes(v.listing.id)));
  const studios = findMatches({ lib, listings, doc: docWith(wide, { filters: { ...lib.EMPTY_FILTERS, kinds: ['studio'] } }), since: before, nowIso: MOCK_NOW, perM2 });
  assert.ok(studios.views.length > 0 && studios.views.every((v) => v.listing.kind === 'studio'));
});

test('unsubscribe signature is HMAC-SHA256(secret, key hash) in hex, as Postgres checks it', () => {
  const secret = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
  const hash = 'a'.repeat(64);
  assert.equal(unsubscribeSig(secret, hash), createHmac('sha256', secret).update(hash).digest('hex'));
  assert.match(unsubscribeUrl(secret, hash), /\/api\/alerts\/unsubscribe\?k=a{64}&t=[0-9a-f]{64}$/);
});

test('digest email: subject, escaped HTML, text part, unsubscribe link', () => {
  const { views, university } = findMatches({ lib, listings, doc: docWith(wide), since: before, nowIso: MOCK_NOW, perM2 });
  const evil = { ...views[0], listing: { ...views[0].listing, title: '<script>x</script> & co' } };
  const mail = digestEmail({ views: [evil, ...views.slice(1)], university, unsubscribe: 'https://h/u?k=1&t=2' });
  assert.match(mail.subject, new RegExp(`^${views.length} new homes? near `));
  assert.ok(!mail.html.includes('<script>x'));
  assert.ok(mail.html.includes('&lt;script&gt;x&lt;/script&gt; &amp; co'));
  assert.ok(mail.text.includes('Stop these emails: https://h/u?k=1&t=2'));
  assert.ok(mail.html.includes('https://h/u?k=1&amp;t=2'));
  const push = pushPayload({ views: views.slice(0, 1), university });
  assert.equal(push.url, `/listings?home=${encodeURIComponent(views[0].listing.id)}`);
});
