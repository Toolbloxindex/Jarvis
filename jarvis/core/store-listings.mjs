import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourceFingerprint, sourceValues, CHECKED_SOURCE_FACTS } from './listing-review.mjs';
import { evaluateListing, DEFAULT_PROFILE } from './matcher.mjs';

export function canonicalUrl(value) {
  try { const u=new URL(value); if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return ''; u.hash=''; for(const key of [...u.searchParams.keys()]) if(/^(utm_|fbclid|ref$|source$)/i.test(key))u.searchParams.delete(key); return u.toString().replace(/\/$/,''); } catch { return ''; }
}

export function listingIdentity(input, canonical) {
  if (input.source_id) return `${input.source}:${input.source_id}`;
  return canonical || `${input.source}:${createHash('sha256').update(`${input.title ?? ''}\n${input.body ?? ''}`).digest('hex')}`;
}

export function planListingUpsert(input, old, identity, canonical) {
  const fingerprint = sourceFingerprint(input);
  if (old && (old.fingerprint === fingerprint || sourceFingerprint(sourceValues(old)) === fingerprint)) {
    // Presentation updates preserve source facts and review state.
    const presentation = Object.fromEntries(['photos', 'photo_version', 'address', 'postcode', 'location']
      .filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
    return { presentation: Object.keys(presentation).some((key) =>
      !isDeepStrictEqual(presentation[key], old[key])) ? presentation : null };
  }

  const previous = old ? sourceValues(old) : {};
  delete previous.owner_facts;
  delete previous.owner_review;
  const timestamp = new Date().toISOString();
  const data = {
    ...previous, ...input,
    ai: old?.ai?.state === 'complete' && old.title === input.title && old.body === input.body ? old.ai : input.ai,
    owner_facts: null, owner_review: old?.owner_review ?? null, url: canonical,
    id: old?.id ?? input.id ?? randomUUID(), identity, fingerprint,
    created_at: old?.created_at ?? timestamp, updated_at: timestamp,
  };
  return { data };
}

export function listingUpdate(old, patch, ownerEdit = false, profile = DEFAULT_PROFILE) {
  const identity = { id: old.id, identity: old.identity, updated_at: new Date().toISOString() };
  const result = { ...old, ...patch, ...identity };
  if (ownerEdit) return { ...result, ...patch.owner_facts?.values };
  const original = sourceValues(old);
  const changed = CHECKED_SOURCE_FACTS.some((key) =>
    Object.hasOwn(patch, key) && !isDeepStrictEqual(patch[key] ?? null, original[key] ?? null));
  if (!changed) return old.owner_facts?.values ? { ...result, ...old.owner_facts.values, owner_facts: old.owner_facts } : result;
  const updated = {
    ...original, ...patch, ...identity, owner_facts: null,
    owner_review: Object.hasOwn(patch, 'owner_review') ? patch.owner_review : old.owner_review ?? null,
    ai: old.ai?.state === 'complete' && result.title === old.title && result.body === old.body ? old.ai : null,
  };
  updated.fingerprint = sourceFingerprint(updated);
  updated.assessment = evaluateListing(updated, profile);
  updated.status = updated.assessment.status;
  return updated;
}
