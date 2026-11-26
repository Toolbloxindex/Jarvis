// Field-level precision/recall on a labelled set.
//   node scripts/ai-eval.mjs [--set=<file.json>] [--mode=deterministic|live] [--verbose]
// The set uses the format of tests/fixtures/ai/ads.json. Keep a set built from
// real ads under the gitignored data/ directory: real ads contain personal data.
// deterministic (default): scores the existing parser alone, offline.
// live: scores the AI alone and the merged result (parser first, AI fills gaps).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_FIELD_NAMES } from '../core/ai-schema.mjs';
import { labelledValues, predictedValues, scoreFields } from '../core/ai-eval.mjs';
import { EXTRACTION_EVIDENCE_VERSION, applyEvidenceBackedFacts, parseListingText } from '../core/matcher.mjs';
import { listingAsAiFields, mergeExtraction } from '../core/ai-merge.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const path = resolve(args.set ?? new URL('../tests/fixtures/ai/ads.json', import.meta.url).pathname);
const { ads } = JSON.parse(readFileSync(path, 'utf8'));
const mode = args.mode ?? 'deterministic';
const baseline = (ad) => ({ ...parseListingText(ad.text, ad.source), ...(ad.structured ?? {}) });

function report(title, cases) {
  const score = scoreFields(cases);
  const pct = (value) => value === null ? '   –' : `${Math.round(value * 100)}%`.padStart(4);
  console.log(`\n${title}: ${score.cases} ads, precision ${pct(score.overall.precision)}, recall ${pct(score.overall.recall)}`);
  console.log('field                 prec  rec   tp  fp  fn');
  for (const name of AI_FIELD_NAMES) {
    const f = score.fields[name];
    if (!f.tp && !f.fp && !f.fn) continue;
    console.log(`${name.padEnd(21)} ${pct(f.precision)} ${pct(f.recall)} ${String(f.tp).padStart(4)}${String(f.fp).padStart(4)}${String(f.fn).padStart(4)}`);
    if (args.verbose) for (const error of f.errors) console.log(`    ${error.id}: expected ${JSON.stringify(error.expected)}, got ${JSON.stringify(error.predicted)}`);
  }
  return score;
}

const expected = (ad) => labelledValues(ad.expected);
report('Deterministic parser', ads.map((ad) => ({ id: ad.id, expected: expected(ad), predicted: listingAsAiFields(baseline(ad)) })));

if (mode === 'live') {
  const [{ Store }, { createAiExtractor }] = await Promise.all([import('../core/store.mjs'), import('../core/ai-extract.mjs')]);
  const store = new Store(':memory:');
  try {
    const extractor = createAiExtractor({ store });
    if (!extractor.enabled) throw new Error('Set a provider key (GEMINI_API_KEY or GROQ_API_KEY) for --mode=live.');
    const aiCases = [];
    const mergedCases = [];
    for (const ad of ads) {
      const result = await extractor.extract(ad.text, { names: ad.names });
      if (result.status !== 'ok') { console.warn(`${ad.id}: ${result.status} (${result.reason})`); continue; }
      aiCases.push({ id: ad.id, expected: expected(ad), predicted: predictedValues(result.fields) });
      const listing = { ...baseline(ad), fingerprint: 'eval' };
      const merged = mergeExtraction(listing, result.fields, result);
      const applied = applyEvidenceBackedFacts({ ...listing, ai: { state: 'complete', extraction: { version: EXTRACTION_EVIDENCE_VERSION, fingerprint: 'eval', fields: merged.fields, evidence: merged.evidence } } });
      mergedCases.push({ id: ad.id, expected: expected(ad), predicted: listingAsAiFields(applied) });
    }
    report('AI only', aiCases);
    report('Parser + AI (merged)', mergedCases);
  } finally {
    store.close();
  }
}
