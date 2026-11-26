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
  return new StorePg(postgres(url, {
    prepare: false, ssl: 'verify-full', max: 2, connect_timeout: 5, idle_timeout: 10,
  }));
}
