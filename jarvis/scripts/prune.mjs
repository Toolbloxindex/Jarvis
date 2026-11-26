import { openStore, storeKind } from '../core/open-store.mjs';

try {
  if (storeKind() !== 'supabase') throw new Error('Pruning requires the Supabase store.');
  const store = await openStore();
  try {
    console.log(JSON.stringify({ historyRowsRemoved: await store.pruneHistory() }));
  } finally {
    await store.close();
  }
} catch {
  console.error('History pruning failed. Check the database configuration and migration.');
  process.exitCode = 1;
}
