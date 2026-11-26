import { readFileSync } from 'node:fs';
import { databasePath, openExistingStore } from './runtime.mjs';
import { Store } from './store.mjs';

export function storeKind(env = process.env) {
  const kind = env.HOUSEWATCH_STORE ?? 'sqlite';
  if (kind !== 'sqlite' && kind !== 'supabase') throw new Error('HOUSEWATCH_STORE must be sqlite or supabase.');
  return kind;
}

export async function openStore({ existing = false, readOnly = false } = {}) {
  if (storeKind() === 'sqlite') {
    return existing || readOnly ? openExistingStore(databasePath(), readOnly) : new Store(databasePath());
  }
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL is required for database operations.');
  const [{ default: postgres }, { StorePg }] = await Promise.all([import('postgres'), import('./store-pg.mjs')]);
  // Supabase's pooler presents a certificate from Supabase's own root CA (public, committed under
  // core/certs). Verify against it: encrypted *and* authenticated, like sslmode=verify-full.
  const ca = readFileSync(new URL('./certs/supabase-prod-ca-2021.crt', import.meta.url), 'utf8');
  return new StorePg(postgres(url, {
    prepare: false, ssl: { ca, rejectUnauthorized: true }, max: 2, connect_timeout: 5, idle_timeout: 10,
  }));
}
