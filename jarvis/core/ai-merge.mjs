// Merge evidence-checked AI fields into a listing without overriding anything.
// Deterministic parser output and structured source fields always win; the AI
// only fills keys that are still unknown, and disagreements become review flags.
import { EXTRACTION_EVIDENCE_VERSION } from './matcher.mjs';
import { AI_FIELD_NAMES, isUnknown } from './ai-schema.mjs';

const money = (n) => `€${new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(n)}`;
const yesNo = (value) => value === true ? 'yes' : value === false ? 'no' : String(value);
const known = (value) => value !== null && value !== undefined && !(Array.isArray(value) && !value.length);
const STUDENT_LEVELS = ['tenantsBsc', 'tenantsMsc', 'tenantsPhd'];

/** The listing's current terms in AI field space, for comparison and evaluation. */
export function listingAsAiFields(listing = {}) {
  const cost = (label) => (listing.monthly_costs ?? []).find((c) => c?.label === label && !c.conditional)?.amount ?? null;
  const tri = (value) => value === true ? 'yes' : value === false ? 'no' : 'unknown';
  const postgrad = listing.degree_restriction === 'postgraduate';
  const students = listing.student_allowed;
  const kind = /^(room|studio|apartment)$/.test(listing.listing_kind ?? '') ? listing.listing_kind : 'unknown';
  return {
    rent: listing.rent_total ?? listing.rent_base ?? null,
    utilitiesIncluded: listing.rent_excludes_bills === true ? false : listing.rent_excludes_bills === false ? true : null,
    serviceCosts: cost('Service charge'),
    utilitiesEstimate: cost('Utilities'),
    deposit: typeof listing.deposit === 'number' ? listing.deposit : null,
    availableFrom: listing.start_date ?? listing.start_month ?? (listing.start_kind === 'immediate' ? 'immediately' : null),
    minMonths: listing.min_stay_months ?? null,
    maxMonths: listing.max_stay_months ?? null,
    indefinite: listing.indefinite ?? null,
    sizeM2: listing.area_m2 ?? null,
    kind,
    furnishing: ['furnished', 'upholstered', 'unfurnished'].includes(listing.furnished) ? listing.furnished : 'unknown',
    registration: listing.registration ?? null,
    tenantsBsc: postgrad ? 'no' : tri(students),
    tenantsMsc: tri(students),
    tenantsPhd: listing.phd_allowed != null ? tri(listing.phd_allowed) : students === false ? 'no' : 'unknown',
    tenantsProfessional: listing.working_only === true ? 'yes' : 'unknown',
    couples: tri(listing.couples_allowed),
    pets: tri(listing.pets_allowed),
    genderRestriction: 'unknown',
    address: listing.address ?? null,
    postcode: listing.postcode ?? listing.location?.postcode ?? null,
  };
}

function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.5;
  if (typeof a === 'string' && typeof b === 'string') {
    const norm = (s) => s.toLowerCase().replace(/[\s,.-]+/g, '');
    return norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
  }
  return a === b;
}

/**
 * Proposed listing patches for each AI field: [{ key, value, flag, label, format }].
 * One AI field can map to several listing keys (rent → rent_total or rent_base).
 */
function proposals(ai) {
  const v = (name) => isUnknown(name, ai[name]?.value) ? null : ai[name].value;
  const out = [];
  const add = (from, key, value, flag, label, format = String) => { if (value !== null && value !== undefined) out.push({ from: [from].flat(), key, value, flag, label, format }); };
  const rent = v('rent');
  const included = v('utilitiesIncluded');
  if (rent !== null) add('rent', included === true ? 'rent_total' : 'rent_base', rent, 'price', 'the rent', money);
  if (included !== null) add('utilitiesIncluded', 'rent_excludes_bills', !included, 'bills', 'whether bills are excluded', yesNo);
  add('deposit', 'deposit', v('deposit'), 'deposit', 'the deposit', money);
  const from = v('availableFrom');
  if (from === 'immediately') add('availableFrom', 'start_kind', 'immediate', 'availability', 'the start date');
  else if (from?.length === 10) add('availableFrom', 'start_date', from, 'availability', 'the start date');
  else if (from) add('availableFrom', 'start_month', from, 'availability', 'the start month');
  add('minMonths', 'min_stay_months', v('minMonths'), 'tenancy', 'the minimum stay', (n) => `${n} months`);
  add('maxMonths', 'max_stay_months', v('maxMonths'), 'tenancy', 'the maximum stay', (n) => `${n} months`);
  add('indefinite', 'indefinite', v('indefinite'), 'tenancy', 'an indefinite contract', yesNo);
  add('sizeM2', 'area_m2', v('sizeM2'), 'size', 'the living area', (n) => `${n} m²`);
  add('kind', 'listing_kind', v('kind'), 'size', 'the property type');
  add('furnishing', 'furnished', v('furnishing'), 'furnishing', 'the furnishing');
  add('registration', 'registration', v('registration'), 'registration', 'address registration', yesNo);
  // PhD candidates are usually employees in the Netherlands, so student_allowed
  // follows bachelor/master only; PhD acceptance has its own key.
  const levels = STUDENT_LEVELS.slice(0, 2).map(v);
  const anyStudent = levels.includes('yes');
  const noStudent = levels.every((level) => level === 'no');
  const studentFrom = STUDENT_LEVELS.slice(0, 2).filter((name) => v(name) !== null);
  if (anyStudent || noStudent) add(studentFrom, 'student_allowed', anyStudent, 'restrictions', 'whether students are accepted', yesNo);
  if (v('tenantsBsc') === 'no' && v('tenantsMsc') === 'yes') {
    add(['tenantsBsc', 'tenantsMsc'], 'degree_restriction', 'postgraduate', 'restrictions', 'the study-level restriction');
  }
  if (v('tenantsPhd') !== null) add('tenantsPhd', 'phd_allowed', v('tenantsPhd') === 'yes', 'restrictions', 'whether PhD candidates are accepted', yesNo);
  if (v('tenantsProfessional') === 'yes' && noStudent && v('tenantsPhd') !== 'yes') add(['tenantsProfessional', ...studentFrom], 'working_only', true, 'restrictions', 'a working-only restriction', yesNo);
  if (v('couples') !== null) add('couples', 'couples_allowed', v('couples') === 'yes', 'restrictions', 'whether couples are accepted', yesNo);
  if (v('pets') !== null) add('pets', 'pets_allowed', v('pets') === 'yes', 'restrictions', 'whether pets are allowed', yesNo);
  if (['female_only', 'male_only'].includes(v('genderRestriction'))) add('genderRestriction', 'household_restriction_unverified', true, 'restrictions', 'a household restriction', yesNo);
  add('address', 'address', v('address'), 'address', 'the address');
  add('postcode', 'postcode', v('postcode'), 'address', 'the postcode');
  return out;
}

/**
 * Merge AI output into a listing.
 * `ai` is the evidence-checked field map from the extractor.
 * Returns { fields, evidence, provenance, conflicts, agreed, suggestions }:
 * - fields/evidence: values for keys the listing leaves unknown (applied at read
 *   time by applyEvidenceBackedFacts, so the stored source facts never change);
 * - provenance: { key: { source: 'ai', provider, model, evidence } };
 * - conflicts: ReviewFlag-shaped { id, field, kind: 'conflict', message };
 * - suggestions: AI readings that could not be applied (owner-confirmed keys,
 *   text the parser marked as conflicting, partially filled cost lists).
 */
export function mergeExtraction(listing, ai, { provider = null, model = null } = {}) {
  const fields = {};
  const evidence = {};
  const provenance = {};
  const conflicts = [];
  const agreed = [];
  const suggestions = [];
  const owner = listing.owner_facts?.values ?? {};
  const quote = (from) => [...new Set(from.map((name) => ai[name]?.evidence).filter(Boolean))].join(' | ').slice(0, 500);
  const disagree = (label, ai, current) => `The description and the listing data disagree on ${label}: the description suggests ${ai}, the listing data says ${current}. Check the original ad.`;
  const flag = (field, message) => {
    if (!conflicts.some((c) => c.message === message)) conflicts.push({ id: `${listing.id ?? 'listing'}-ai-${field}-${conflicts.length + 1}`, field, kind: 'conflict', message });
  };
  const fill = (key, value, from) => {
    fields[key] = value;
    evidence[key] = quote(from);
    provenance[key] = { source: 'ai', provider, model, fields: from, evidence: evidence[key] };
  };
  const rentKnown = known(listing.rent_total) || known(listing.rent_base);

  for (const p of proposals(ai)) {
    if (Object.hasOwn(owner, p.key)) { suggestions.push({ key: p.key, value: p.value, reason: 'owner_confirmed' }); continue; }
    if (p.key === 'rent_total' || p.key === 'rent_base') {
      const current = listing.rent_total ?? listing.rent_base;
      if (!rentKnown) fill(p.key, p.value, p.from);
      else if (same(current, p.value)) agreed.push(p.key);
      else flag(p.flag, disagree('the rent', p.format(p.value), money(current)));
      continue;
    }
    if (p.key === 'start_month' && known(listing.start_date)) {
      if (!same(listing.start_date.slice(0, 7), p.value)) flag(p.flag, disagree('the start date', p.value, listing.start_date));
      else agreed.push(p.key);
      continue;
    }
    if (p.key === 'start_kind' && (known(listing.start_date) || known(listing.start_month))) {
      flag(p.flag, disagree('the start date', 'immediately', listing.start_date ?? listing.start_month));
      continue;
    }
    const current = listing[p.key];
    if (current === 'conflicting') {
      suggestions.push({ key: p.key, value: p.value, reason: 'text_conflict', evidence: quote(p.from) });
      flag(p.flag, `The ad's wording about ${p.label} conflicts; the AI reading is ${p.format(p.value)}. Check the original ad.`);
      continue;
    }
    if (!known(current)) { fill(p.key, p.value, p.from); continue; }
    if (same(current, p.value)) { agreed.push(p.key); continue; }
    flag(p.flag, disagree(p.label, p.format(p.value), p.format(current)));
  }

  // Monthly charges live in one list, so the AI can only fill it when it is empty.
  const costs = [['serviceCosts', 'Service charge', false], ['utilitiesEstimate', 'Utilities', true]]
    .filter(([name]) => !isUnknown(name, ai[name]?.value))
    .map(([name, label, estimated]) => ({ name, label, amount: ai[name].value, conditional: false, ...(estimated ? { estimated: true } : {}), evidence: ai[name].evidence, source: 'ai' }));
  const existing = (listing.monthly_costs ?? []).filter((c) => !c.conditional);
  for (const cost of costs) {
    const match = existing.find((c) => c.label === cost.label);
    if (match && !same(match.amount, cost.amount)) flag('bills', disagree(`the ${cost.label.toLowerCase()} cost`, money(cost.amount), money(match.amount)));
    else if (match) agreed.push(`monthly_costs.${cost.label}`);
  }
  if (costs.length && !known(listing.monthly_costs) && !Object.hasOwn(owner, 'monthly_costs')) {
    fill('monthly_costs', costs.map((cost) => Object.fromEntries(Object.entries(cost).filter(([key]) => key !== 'name'))), costs.map((c) => c.name));
  } else {
    for (const cost of costs) if (!existing.some((c) => c.label === cost.label)) suggestions.push({ key: 'monthly_costs', value: cost, reason: 'list_partially_known' });
  }

  // Keep the known monthly minimum consistent with any AI-filled rent and charges.
  if (!known(listing.rent_known_monthly_min) && (known(fields.rent_total) || known(fields.rent_base))) {
    const charges = (fields.monthly_costs ?? existing).filter((c) => !c.conditional && typeof c.amount === 'number');
    fields.rent_known_monthly_min = fields.rent_total ?? Math.round((fields.rent_base + charges.reduce((sum, c) => sum + c.amount, 0)) * 100) / 100;
    provenance.rent_known_monthly_min = { source: 'ai', provider, model, fields: ['rent', 'serviceCosts', 'utilitiesEstimate'], evidence: evidence.rent_total ?? evidence.rent_base };
    evidence.rent_known_monthly_min = provenance.rent_known_monthly_min.evidence;
  }
  if (known(fields.start_date) && !known(listing.start_kind)) fields.start_kind = 'earliest';
  return { fields, evidence, provenance, conflicts, agreed, suggestions };
}

/** The `listing.ai` record consumed by applyEvidenceBackedFacts in core/matcher.mjs. */
export function aiRecord(listing, result, merged, { at = new Date().toISOString(), schema } = {}) {
  return {
    state: 'complete',
    extraction: {
      version: EXTRACTION_EVIDENCE_VERSION,
      fingerprint: listing.fingerprint ?? null,
      fields: merged.fields,
      evidence: merged.evidence,
      provenance: merged.provenance,
      conflicts: merged.conflicts,
      suggestions: merged.suggestions,
      agreed: merged.agreed,
      ...(merged.shadow ? { shadow: merged.shadow } : {}),
      raw: Object.fromEntries(AI_FIELD_NAMES.filter((name) => !isUnknown(name, result.fields[name]?.value)).map((name) => [name, result.fields[name]])),
      dropped: result.dropped ?? [],
      provider: result.provider,
      model: result.model,
      cached: !!result.cached,
      schema,
      textHash: result.textHash,
      at,
    },
  };
}
