import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionPooler } from '../core/open-store.mjs';

test('moves the Supabase transaction pooler to session mode', () => {
  assert.equal(
    sessionPooler('postgresql://postgres.ref:p%40ss@aws-0-eu-west-1.pooler.supabase.com:6543/postgres'),
    'postgresql://postgres.ref:p%40ss@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
  );
});

test('leaves other database URLs alone', () => {
  for (const url of [
    'postgresql://postgres.ref:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres:x@db.ref.supabase.co:6543/postgres',
    'postgresql://u:x@localhost:6543/db',
  ]) assert.equal(sessionPooler(url), url);
});
