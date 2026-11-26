// Show exactly what AI extraction would send for one synthetic fixture.
//   node scripts/ai-extract-sample.mjs [--fixture=<id>] [--schema] [--live]
// Dry run (default) prints the redacted ad, the prompt, the provider chain and
// the cache key without any network access. --live (with a provider key set)
// extracts that one fixture using a throwaway in-memory store.
import { readFileSync } from 'node:fs';
import { AI_SCHEMA } from '../core/ai-schema.mjs';
import { buildMessages } from '../core/ai-prompt.mjs';
import { normalizeText, redactForModel } from '../core/ai-redact.mjs';
import { SCHEMA_TAG, aiTargets, cacheKey, createAiExtractor } from '../core/ai-extract.mjs';
import { mergeExtraction } from '../core/ai-merge.mjs';
import { unknownKeyGroups } from '../core/ai-collect.mjs';
import { parseListingText } from '../core/matcher.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const { ads } = JSON.parse(readFileSync(new URL('../tests/fixtures/ai/ads.json', import.meta.url), 'utf8'));
const fixture = ads.find((ad) => ad.id === (args.fixture ?? ads[0].id));
if (!fixture) {
  console.error(`Unknown fixture. Choose one of: ${ads.map((ad) => ad.id).join(', ')}`);
  process.exit(1);
}

const redacted = redactForModel(fixture.text, { names: fixture.names });
const messages = buildMessages(redacted.text);
const deterministic = { ...parseListingText(fixture.text, fixture.source), ...(fixture.structured ?? {}) };
const targets = aiTargets();
const characters = messages.reduce((sum, message) => sum + message.content.length, 0);

console.log(`Fixture: ${fixture.id} (${fixture.source}, ${fixture.language})`);
console.log(`Schema/prompt: ${SCHEMA_TAG}`);
console.log(`Redactions: ${JSON.stringify(redacted.counts)}${redacted.truncated ? ' (input truncated)' : ''}`);
console.log(`Unknown after the deterministic parser: ${unknownKeyGroups(deterministic).join(', ') || 'none'}`);
console.log(`Provider chain: ${targets.length ? targets.map((t) => `${t.id}${t.paid ? ' (paid)' : ''} rpm=${t.rpm} rpd=${t.rpd}${t.tpd ? ` tpd=${t.tpd}` : ''}`).join(' → ') : 'none (no provider key set; extraction is off)'}`);
for (const target of targets) console.log(`Cache key ${target.id}: ${cacheKey(normalizeText(redacted.text), target.model)}`);
console.log(`Prompt: ${messages.length} messages, ~${Math.round(characters / 4)} input tokens (4 characters per token estimate)`);
console.log('\n--- Redacted ad (the only ad text that leaves the machine) ---');
console.log(redacted.text);
console.log('\n--- System prompt ---');
console.log(messages[0].content);
console.log(`\n--- Few-shot: ${(messages.length - 2) / 2} synthetic example pairs (see core/ai-prompt.mjs) ---`);
console.log('\n--- Final user message ---');
console.log(messages.at(-1).content);
if (args.schema) {
  console.log('\n--- JSON schema (response_format.json_schema.schema) ---');
  console.log(JSON.stringify(AI_SCHEMA, null, 2));
} else {
  console.log(`\n(Pass --schema to print the ${Object.keys(AI_SCHEMA.properties).length}-field JSON schema.)`);
}

if (args.live) {
  if (!targets.length) {
    console.error('\n--live needs GEMINI_API_KEY, GROQ_API_KEY or a provider listed in HOUSEWATCH_AI_PROVIDERS with its key.');
    process.exit(1);
  }
  const { Store } = await import('../core/store.mjs');
  const store = new Store(':memory:');
  try {
    const result = await createAiExtractor({ store }).extract(fixture.text, { names: fixture.names });
    console.log('\n--- Live result ---');
    if (result.status !== 'ok') {
      console.log(`${result.status}: ${result.reason}`);
      process.exitCode = 1;
    } else {
      const known = Object.fromEntries(Object.entries(result.fields).filter(([, f]) => f.value !== null && f.value !== 'unknown'));
      console.log(`${result.provider} / ${result.model}`);
      console.log(JSON.stringify({ fields: known, dropped: result.dropped }, null, 2));
      const merged = mergeExtraction(deterministic, result.fields, result);
      console.log(JSON.stringify({ filled: merged.fields, conflicts: merged.conflicts, suggestions: merged.suggestions }, null, 2));
    }
  } finally {
    store.close();
  }
}
