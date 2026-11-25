import { runPublicDiscovery } from '../core/discovery.mjs';
import { databasePath } from '../core/runtime.mjs';
import { Store } from '../core/store.mjs';

try {
  const store = new Store(databasePath());
  try {
    const { checked, added, changed } = await runPublicDiscovery(store);
    console.log(JSON.stringify({ checked, added, changed }));
  } finally {
    store.close();
  }
} catch {
  console.error('Collection failed. Check the SQLite path and permissions.');
  process.exitCode = 1;
}
