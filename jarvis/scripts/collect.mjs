import { runCollector } from '../core/collector.mjs';
import { openStore } from '../core/open-store.mjs';

try {
  const store = await openStore();
  try {
    console.log(JSON.stringify(await runCollector(store)));
  } finally {
    await store.close();
  }
} catch (error) {
  // Public logs: say what failed, never print credentials (connection strings, tokens).
  const safe = String(error?.stack ?? error)
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgresql://***')
    .replace(/(token|key|password|secret)=([^&\s]+)/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
  console.error('Collection failed:', safe.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
}
