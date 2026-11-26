// Strict JSON schema for AI-assisted extraction plus the hand-written validator.
// The wire schema only uses keywords every provider honours (types, enums,
// required, additionalProperties). Ranges, patterns and lengths are enforced
// here because Gemini ignores several constraint keywords.

export const AI_SCHEMA_VERSION = 1;
export const AI_SCHEMA_NAME = 'housing_ad_terms';

const TRI = ['yes', 'no', 'unknown'];
const nullable = (type) => ({ type: [type, 'null'] });
const choice = (values) => ({ type: 'string', enum: [...values, 'unknown'] });

/** Field definitions. `unknown` is the value used when the ad does not say. */
export const AI_FIELDS = Object.freeze({
  rent: { schema: nullable('number'), unknown: null, kind: 'money', min: 50, max: 10000, description: 'Monthly rent in EUR as advertised.' },
  utilitiesIncluded: { schema: nullable('boolean'), unknown: null, kind: 'flag', description: 'True when gas, water and electricity are included in the rent.' },
  serviceCosts: { schema: nullable('number'), unknown: null, kind: 'money', min: 0, max: 1500, description: 'Separately stated monthly service costs in EUR.' },
  utilitiesEstimate: { schema: nullable('number'), unknown: null, kind: 'money', min: 0, max: 1500, description: 'Separately stated monthly utilities amount or advance in EUR.' },
  deposit: { schema: nullable('number'), unknown: null, kind: 'money', min: 0, max: 30000, description: 'Deposit in EUR, only when an amount is written.' },
  availableFrom: { schema: nullable('string'), unknown: null, kind: 'date', description: 'YYYY-MM-DD, YYYY-MM or "immediately".' },
  minMonths: { schema: nullable('integer'), unknown: null, kind: 'months', min: 1, max: 120, description: 'Minimum tenancy in whole months.' },
  maxMonths: { schema: nullable('integer'), unknown: null, kind: 'months', min: 1, max: 120, description: 'Maximum tenancy in whole months.' },
  indefinite: { schema: nullable('boolean'), unknown: null, kind: 'flag', description: 'True for an indefinite contract, false for a fixed term.' },
  sizeM2: { schema: nullable('number'), unknown: null, kind: 'area', min: 5, max: 400, description: 'Living area in square metres.' },
  kind: { schema: choice(['room', 'studio', 'apartment']), unknown: 'unknown', kind: 'enum', description: 'Property type.' },
  furnishing: { schema: choice(['furnished', 'upholstered', 'unfurnished']), unknown: 'unknown', kind: 'enum', description: 'Furnishing level.' },
  registration: { schema: nullable('boolean'), unknown: null, kind: 'flag', description: 'Whether municipal address registration is possible.' },
  tenantsBsc: { schema: { type: 'string', enum: TRI }, unknown: 'unknown', kind: 'enum', description: 'Bachelor students accepted.' },
  tenantsMsc: { schema: { type: 'string', enum: TRI }, unknown: 'unknown', kind: 'enum', description: 'Master students accepted.' },
  tenantsPhd: { schema: { type: 'string', enum: TRI }, unknown: 'unknown', kind: 'enum', description: 'PhD candidates accepted.' },
  tenantsProfessional: { schema: { type: 'string', enum: TRI }, unknown: 'unknown', kind: 'enum', description: 'Working professionals accepted.' },
  couples: { schema: { type: 'string', enum: TRI }, unknown: 'unknown', kind: 'enum', description: 'Couples accepted.' },
  pets: { schema: { type: 'string', enum: TRI }, unknown: 'unknown', kind: 'enum', description: 'Pets accepted.' },
  genderRestriction: { schema: choice(['none', 'female_only', 'male_only']), unknown: 'unknown', kind: 'enum', description: 'Stated gender restriction.' },
  address: { schema: nullable('string'), unknown: null, kind: 'address', description: 'Street and house number when stated.' },
  postcode: { schema: nullable('string'), unknown: null, kind: 'postcode', description: 'Dutch postcode, e.g. 2611 AB.' },
});
export const AI_FIELD_NAMES = Object.freeze(Object.keys(AI_FIELDS));
const MAX_EVIDENCE = 300;

export const AI_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: AI_FIELD_NAMES,
  properties: Object.fromEntries(Object.entries(AI_FIELDS).map(([name, field]) => [name, {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'evidence'],
    description: field.description,
    properties: { value: field.schema, evidence: nullable('string') },
  }])),
});

/** An all-unknown result, the shape every provider must return. */
export function emptyExtraction() {
  return Object.fromEntries(AI_FIELD_NAMES.map((name) => [name, { value: AI_FIELDS[name].unknown, evidence: null }]));
}

export function isUnknown(name, value) {
  return value === null || value === undefined || value === AI_FIELDS[name]?.unknown;
}

function typeMatches(schema, value) {
  const types = [schema.type].flat();
  if (value === null) return types.includes('null');
  if (schema.enum && !schema.enum.includes(value)) return false;
  return types.some((type) => type === 'integer' ? Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === type);
}

function validDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return date.toISOString().slice(0, 10) === value && +m[1] >= 2020 && +m[1] <= 2100;
}

function rangeError(name, value) {
  const field = AI_FIELDS[name];
  if (field.min !== undefined && (value < field.min || value > field.max)) return 'range';
  if (field.kind === 'date' && !(value === 'immediately' || validDay(value) ||
    /^(20[2-9]\d|2100)-(0[1-9]|1[0-2])$/.test(value))) return 'format';
  if (field.kind === 'postcode' && !/^[1-9]\d{3}\s?[A-Z]{2}$/i.test(value)) return 'format';
  if (field.kind === 'address' && (value.length > 120 || !/\p{L}{3}/u.test(value))) return 'format';
  return null;
}

/**
 * Parse and check a provider response. A structural failure (not JSON, missing
 * or extra keys, wrong field shape) means the provider ignored the schema and
 * the caller retries or falls back. A bad individual value is dropped.
 */
export function validateExtraction(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { data = JSON.parse(text); } catch { return { ok: false, error: 'The response is not valid JSON.' }; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'The response is not a JSON object.' };
  const extra = Object.keys(data).filter((key) => !Object.hasOwn(AI_FIELDS, key));
  const missing = AI_FIELD_NAMES.filter((key) => !Object.hasOwn(data, key));
  if (extra.length || missing.length) return { ok: false, error: `Schema mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).` };
  const fields = emptyExtraction();
  const dropped = [];
  let typeErrors = 0;
  for (const name of AI_FIELD_NAMES) {
    const entry = data[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('value' in entry) || !('evidence' in entry) ||
        Object.keys(entry).length !== 2) return { ok: false, error: `Field ${name} has the wrong shape.` };
    const { value, evidence } = entry;
    if (!typeMatches(AI_FIELDS[name].schema, value) || (evidence !== null && typeof evidence !== 'string')) {
      typeErrors++;
      dropped.push({ field: name, reason: 'type' });
      continue;
    }
    if (isUnknown(name, value)) continue;
    const error = rangeError(name, value);
    if (error) { dropped.push({ field: name, reason: error }); continue; }
    if (typeof evidence === 'string' && evidence.length > MAX_EVIDENCE) { dropped.push({ field: name, reason: 'evidence_too_long' }); continue; }
    fields[name] = { value: AI_FIELDS[name].kind === 'postcode' ? value.toUpperCase().replace(/^(\d{4})\s?/, '$1 ') : value, evidence };
  }
  if (typeErrors > AI_FIELD_NAMES.length / 2) return { ok: false, error: 'Most fields have the wrong type.' };
  return { ok: true, fields, dropped };
}

/** Case-insensitive, whitespace- and punctuation-variant-insensitive form used for quote matching. */
export function normalizeQuote(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
}

function stripQuote(value) {
  return normalizeQuote(value).replace(/^(?:\.{3}|…|["'`])+\s*/, '').replace(/\s*(?:\.{3}|…|["'`])+$/, '').trim();
}

/** Every number written in a quote, read with both Dutch and English separators. */
export function numbersIn(text) {
  const out = new Set();
  for (const [token] of String(text).matchAll(/\d+(?:[.,  ]\d{3})*(?:[.,]\d{1,2})?/g)) {
    const compact = token.replace(/[  ]/g, '');
    out.add(Number(compact.replace(/[.,]/g, '')));
    out.add(Number(compact.replace(/,/g, '')));
    out.add(Number(compact.replace(/\./g, '').replace(',', '.')));
  }
  return [...out].filter(Number.isFinite);
}

function valueSupported(name, value, quote) {
  const { kind } = AI_FIELDS[name];
  const numbers = numbersIn(quote);
  if (kind === 'money' || kind === 'area') return numbers.some((n) => Math.abs(n - value) < 0.01);
  if (kind === 'months') return !numbers.length || numbers.some((n) => n === value || n * 12 === value);
  if (kind === 'date') {
    const years = [...quote.matchAll(/\b(20\d{2})\b/g)].map((m) => m[1]);
    return value === 'immediately' || !years.length || years.includes(value.slice(0, 4));
  }
  if (kind === 'postcode') return quote.replace(/\s/g, '').includes(value.toLowerCase().replace(/\s/g, ''));
  if (kind === 'address') {
    const street = normalizeQuote(value).match(/\p{L}[\p{L}'-]{2,}/u)?.[0];
    return !!street && quote.includes(street);
  }
  return true;
}

/**
 * Keep only values whose evidence quote occurs in the text the model saw, and
 * whose number, year or postcode also appears in that quote. Values without
 * evidence are dropped rather than trusted.
 */
const INJECTION = /\b(?:ignore|disregard|forget|override)\b[^\n]{0,40}\b(?:instructions?|prompt|rules)\b|\b(?:negeer|vergeet)\b[^\n]{0,40}\b(?:instructies?|opdracht(?:en)?|regels)\b|\bsystem prompt\b|\b(?:you are|act as) (?:an? )?(?:ai|assistant|model|chatgpt|gemini)\b|\b(?:set|output|return|zet)\b[^\n]{0,30}\b(?:rent|registration|huur|inschrijving|field|value)s?\s+(?:to|op|=)\b/i;

/** Lines that try to instruct the model. Values quoted from them are never trusted. */
export function injectionLines(text) {
  return String(text ?? '').split(/\n|(?<=[.!?])\s+/).filter((line) => INJECTION.test(line)).map(normalizeQuote);
}

export function enforceEvidence(fields, sourceText) {
  const haystack = normalizeQuote(sourceText);
  const suspect = injectionLines(sourceText);
  const kept = emptyExtraction();
  const dropped = [];
  for (const name of AI_FIELD_NAMES) {
    const { value, evidence } = fields[name] ?? {};
    if (isUnknown(name, value)) continue;
    const quote = stripQuote(evidence);
    if (quote.length < 2) { dropped.push({ field: name, reason: 'no_evidence' }); continue; }
    if (/\[(?:phone|email|link|handle|name|iban)\]/.test(quote) && quote.replace(/\[[a-z]+\]/g, '').trim().length < 3) {
      dropped.push({ field: name, reason: 'no_evidence' });
      continue;
    }
    if (!haystack.includes(quote)) { dropped.push({ field: name, reason: 'evidence_not_found' }); continue; }
    if (suspect.some((line) => line.includes(quote) || quote.includes(line))) { dropped.push({ field: name, reason: 'instruction_in_ad' }); continue; }
    if (!valueSupported(name, value, quote)) { dropped.push({ field: name, reason: 'value_not_in_evidence' }); continue; }
    kept[name] = { value, evidence: String(evidence).trim() };
  }
  return { fields: kept, dropped };
}
