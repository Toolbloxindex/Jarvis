// Field-level precision/recall for extraction against a labelled set.
// A prediction counts only when it is not unknown; "unknown" is never wrong,
// it only costs recall. A wrong value costs both precision and recall.
import { AI_FIELD_NAMES, AI_FIELDS, isUnknown } from './ai-schema.mjs';

/** Labels are { field: [value, evidence] } (or bare values); unlisted fields are unknown. */
export function labelledValues(labels = {}) {
  return Object.fromEntries(AI_FIELD_NAMES.map((name) => {
    const label = labels[name];
    return [name, Array.isArray(label) ? label[0] : label ?? AI_FIELDS[name].unknown];
  }));
}

/** Field values from an extractor result ({ field: { value, evidence } }). */
export function predictedValues(fields = {}) {
  return Object.fromEntries(AI_FIELD_NAMES.map((name) => {
    const entry = fields[name];
    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
    return [name, value ?? AI_FIELDS[name].unknown];
  }));
}

function equal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.5;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase().replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/\s+/g, ' ').trim();
  return a === b;
}

const ratio = (a, b) => b ? Math.round((a / b) * 1000) / 1000 : null;

/** cases: [{ id, expected: {field: value}, predicted: {field: value} }] */
export function scoreFields(cases) {
  const fields = Object.fromEntries(AI_FIELD_NAMES.map((name) => [name, { tp: 0, fp: 0, fn: 0, errors: [] }]));
  for (const { id, expected, predicted } of cases) {
    for (const name of AI_FIELD_NAMES) {
      const want = expected[name];
      const got = predicted[name];
      const score = fields[name];
      const hasWant = !isUnknown(name, want);
      const hasGot = !isUnknown(name, got);
      if (hasGot && hasWant && equal(want, got)) score.tp++;
      else {
        if (hasGot) score.fp++;
        if (hasWant) score.fn++;
        if (hasGot || hasWant) score.errors.push({ id, expected: want ?? null, predicted: got ?? null });
      }
    }
  }
  const total = { tp: 0, fp: 0, fn: 0 };
  for (const score of Object.values(fields)) {
    for (const key of ['tp', 'fp', 'fn']) total[key] += score[key];
    score.precision = ratio(score.tp, score.tp + score.fp);
    score.recall = ratio(score.tp, score.tp + score.fn);
  }
  return { cases: cases.length, fields, overall: { ...total, precision: ratio(total.tp, total.tp + total.fp), recall: ratio(total.tp, total.tp + total.fn) } };
}
