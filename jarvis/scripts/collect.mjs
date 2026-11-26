import { runCollector } from '../core/collector.mjs';
import { openStore } from '../core/open-store.mjs';

try {
  const store = await openStore();
  try {
    console.log(JSON.stringify(await runCollector(store)));
  } finally {
    await store.close();
  }
} catch {
  console.error('Collection failed. Check the configured database and collector settings.');
  process.exitCode = 1;
}
