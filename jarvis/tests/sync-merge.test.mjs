import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, mergeDocs, prune, stamp, valueOf } from '../lib/sync.ts';

test('saved homes from two devices merge as a union', () => {
  const a = stamp({}, 'saved', ['h1', 'h2'], 10);
  const b = stamp({}, 'saved', ['h3'], 11);
  assert.deepEqual(valueOf(mergeDocs(a, b), 'saved'), ['h1', 'h2', 'h3']);
  assert.equal(canonical(mergeDocs(a, b)), canonical(mergeDocs(b, a)), 'merge order does not matter');
});

test('a later removal beats an earlier add, and a later re-add beats the removal', () => {
  const base = stamp({}, 'saved', ['h1'], 10);
  const removed = stamp(base, 'saved', [], 20);
  assert.deepEqual(valueOf(mergeDocs(base, removed), 'saved'), []);
  const readded = stamp(removed, 'saved', ['h1'], 30);
  assert.deepEqual(valueOf(mergeDocs(removed, readded), 'saved'), ['h1']);
});

test('notes merge per home; the latest edit wins', () => {
  const a = stamp({}, 'notes', { h1: 'call landlord', h2: 'nice' }, 10);
  const b = stamp(a, 'notes', { h1: 'viewing Friday', h2: 'nice' }, 20);
  const c = stamp(a, 'notes', { h1: 'call landlord', h2: 'nice', h3: 'too far' }, 15);
  assert.deepEqual(valueOf(mergeDocs(b, c), 'notes'), { h1: 'viewing Friday', h2: 'nice', h3: 'too far' });
});

test('search and filters: the latest change wins; unchanged values are not restamped', () => {
  const a = stamp({}, 'search', { university: 'tud', budget: 900 }, 10);
  const b = stamp({}, 'search', { university: 'eur', budget: 700 }, 12);
  assert.deepEqual(valueOf(mergeDocs(a, b), 'search'), { university: 'eur', budget: 700 });
  assert.equal(stamp(a, 'search', { budget: 900, university: 'tud' }, 99).v.search.t, 10);
});

test('layout keys are device-local and never enter the document', () => {
  assert.deepEqual(stamp({}, 'mapOn', false, 10), {});
});

test('old removals are pruned, recent ones kept', () => {
  const day = 24 * 3600 * 1000;
  const now = 200 * day;
  let doc = stamp({}, 'passed', ['old', 'recent', 'kept'], 1);
  doc = stamp(doc, 'passed', ['recent', 'kept'], now - 100 * day);
  doc = stamp(doc, 'passed', ['kept'], now - day);
  const pruned = prune(doc, now);
  assert.deepEqual(Object.keys(pruned.s.passed).sort(), ['kept', 'recent']);
});

test('canonical JSON ignores key order (Postgres jsonb reorders keys)', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] } }), canonical({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 }));
});
