import { statSync } from 'node:fs';
import { Store } from './store.mjs';

export function databasePath() {
  return process.env.HOUSEWATCH_DB ?? './data/housing.sqlite';
}

export function openExistingStore(path, readOnly = true) {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile()) throw new Error('The Housewatch database path must point to a file.');
  return new Store(path, { readOnly, existing: true });
}

export function validListingId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
}
