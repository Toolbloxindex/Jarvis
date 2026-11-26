// Collector pass for AI-assisted extraction. Runs after discovery, processes
// at most HOUSEWATCH_AI_BUDGET provider calls per run, and never fails the
// collection: any error is logged and the remaining work stays queued.
import { createHash } from 'node:crypto';
import { DEFAULT_PROFILE, EXTRACTION_EVIDENCE_VERSION, evaluateListing } from './matcher.mjs';
import { SCHEMA_TAG, createAiExtractor } from './ai-extract.mjs';
import { aiRecord, mergeExtraction } from './ai-merge.mjs';
import { normalizeText } from './ai-redact.mjs';

export const AI_QUEUE_KEY = 'collector.ai.pending';
const QUEUE_LIMIT = 500;
const MAX_ATTEMPTS = 3;
let disabledLogged = false;

export function aiBudget(value = process.env.HOUSEWATCH_AI_BUDGET ?? '20') {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('HOUSEWATCH_AI_BUDGET must be a nonnegative integer.');
  return Number(value);
}

const known = (value) => value !== null && value !== undefined && !(Array.isArray(value) && !value.length);
/** Groups of keys where at least one must be known; an all-unknown group justifies an AI call. */
const KEY_GROUPS = [
  ['rent_base', 'rent_total'], ['rent_excludes_bills', 'monthly_costs'], ['deposit'], ['start_date', 'start_month', 'start_kind'],
  ['min_stay_months', 'max_stay_months', 'indefinite'], ['area_m2'], ['furnished'], ['registration'],
  ['student_allowed', 'degree_restriction', 'working_only'], ['couples_allowed'], ['pets_allowed'],
];

export function aiText(listing) {
  return [listing.title, listing.body].filter((part) => typeof part === 'string' && part.trim()).join('\n');
}
export function aiTextHash(listing) {
  return createHash('sha256').update(normalizeText(aiText(listing))).digest('hex');
}

export function unknownKeyGroups(listing) {
  return KEY_GROUPS.filter((group) => group.every((key) => !known(listing[key]))).map((group) => group[0]);
}

/** True when an ad is worth (re)extracting: real offer, enough text, key terms unknown, not already done. */
export function needsAiExtraction(listing) {
  if (!listing || typeof listing.body !== 'string' || listing.body.trim().length < 60) return false;
  if (listing.availability === 'unavailable' || listing.wanted_ad || listing.sale_ad || listing.listing_kind === 'general_lead') return false;
  const done = listing.ai?.state === 'complete' && listing.ai.extraction?.schema === SCHEMA_TAG &&
    listing.ai.extraction.version === EXTRACTION_EVIDENCE_VERSION && listing.ai.extraction.fingerprint === listing.fingerprint;
  return !done && unknownKeyGroups(listing).length > 0;
}

function queueEntries(value) {
  return (Array.isArray(value) ? value : []).map((entry) => typeof entry === 'string' ? { id: entry, attempts: 0 } : entry)
    .filter((entry) => typeof entry?.id === 'string');
}

/**
 * Process queued listings. `ids` are the listings discovery added or changed
 * this run. Returns counts for the collector summary.
 */
export async function runAiPass(store, ids = [], {
  env = process.env, budget = () => aiBudget(env.HOUSEWATCH_AI_BUDGET ?? '20'),
  makeExtractor = (options) => createAiExtractor(options), profile,
  log = (message) => console.warn(message), now = Date.now, backfill = env.HOUSEWATCH_AI_BACKFILL === '1',
} = {}) {
  const summary = { aiChecked: 0, aiUpdated: 0, aiCached: 0, aiFailed: 0, aiConflicts: 0, aiEnabled: false };
  try {
    const extractor = makeExtractor({ store, env, log, now });
    if (!extractor.enabled) {
      if (!disabledLogged) log('AI extraction is off: no provider key is set (GEMINI_API_KEY, GROQ_API_KEY, ...).');
      disabledLogged = true;
      return summary;
    }
    summary.aiEnabled = true;
    const limit = budget();
    const queued = queueEntries(await store.getConfig(AI_QUEUE_KEY, []));
    const seen = new Set(queued.map((entry) => entry.id));
    for (const id of ids) if (!seen.has(id)) { queued.push({ id, attempts: 0 }); seen.add(id); }
    if (backfill) {
      for (const listing of await store.getListings()) {
        if (!seen.has(listing.id) && needsAiExtraction(listing)) { queued.push({ id: listing.id, attempts: 0 }); seen.add(listing.id); }
      }
    }
    const listingProfile = profile ?? await store.getConfig('profile', DEFAULT_PROFILE);
    const remaining = [];
    let calls = 0;
    let stop = false;
    for (const entry of queued) {
      if (stop || calls >= limit) { remaining.push(entry); continue; }
      const listing = await store.getListing(entry.id);
      if (!needsAiExtraction(listing)) continue;
      summary.aiChecked++;
      const result = await extractor.extract(aiText(listing));
      if (!result.cached && ['ok', 'failed'].includes(result.status)) calls++;
      if (result.status === 'budget' || result.status === 'disabled') { stop = true; remaining.push(entry); summary.aiChecked--; continue; }
      if (result.status !== 'ok') {
        if (result.status === 'failed') {
          summary.aiFailed++;
          if (entry.attempts + 1 < MAX_ATTEMPTS) remaining.push({ id: entry.id, attempts: entry.attempts + 1 });
        }
        continue;
      }
      if (result.cached) summary.aiCached++;
      const merged = mergeExtraction(listing, result.fields, result);
      // Shadow mode records what the AI would fill without applying it.
      if (env.HOUSEWATCH_AI_APPLY === '0') Object.assign(merged, { shadow: merged.fields, fields: {}, evidence: {} });
      const ai = aiRecord(listing, result, merged, { at: new Date(now()).toISOString(), schema: SCHEMA_TAG });
      const assessment = evaluateListing({ ...listing, ai }, listingProfile);
      await store.updateListing(listing.id, { ai, assessment, status: assessment.status });
      summary.aiConflicts += merged.conflicts.length;
      if (Object.keys(merged.fields).length || merged.conflicts.length) summary.aiUpdated++;
    }
    await store.setConfig(AI_QUEUE_KEY, remaining.slice(0, QUEUE_LIMIT));
  } catch (error) {
    // Fail safe: AI is an enrichment. Collection results are already stored.
    log(`AI extraction pass stopped: ${error instanceof Error ? error.message : 'unknown error'}`);
    summary.aiError = true;
  }
  return summary;
}
