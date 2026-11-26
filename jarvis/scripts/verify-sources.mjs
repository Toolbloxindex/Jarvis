import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSourceFetcher, parseDetail, parseIndex, SOURCES } from '../core/discovery.mjs';
import { databasePath, openExistingStore } from '../core/runtime.mjs';
import { mapStoredListings } from '../lib/server/listings-data.ts';

const singleProbe = new Set(['pararius', 'funda']);
const root = 'data/verify';

async function state(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}

function localHealth(source) {
  if (process.env.HOUSEWATCH_STORE === 'supabase') return {};
  const store = openExistingStore(databasePath());
  try { return store?.getConfig('discovery.health.' + source, {}) ?? {}; }
  finally { store?.close(); }
}

const show = (value) => value ?? '—';
export function coverage(listing, now = new Date().toISOString()) {
  const mapped = mapStoredListings([{ ...listing, id: 'verify', created_at: now, updated_at: now }], [],
    () => ({ status: 'ready' }), now);
  const ad = mapped.source === 'live' ? mapped.listings[0] : null;
  if (!ad) return { url: listing.url, kind: 'excluded' };
  const { costs, tenancy, location, eligibility } = ad;
  return {
    url: listing.url, kind: show(ad.kind), baseRent: show(costs.rent), advertised: show(ad.advertisedRent),
    service: show(costs.serviceCosts), utilities: show(costs.utilities),
    bills: costs.billsIncluded === null ? 'unknown' : costs.billsIncluded ? 'included' : 'excluded',
    deposit: show(costs.deposit), availableFrom: tenancy.availableFrom ?? listing.start_month ?? listing.availability_text ?? '—',
    minMonths: show(tenancy.minMonths), maxMonths: show(tenancy.maxMonths), sizeM2: show(ad.sizeM2),
    furnishing: show(ad.furnishing), registration: ad.registration,
    restrictions: [
      listing.student_allowed === false ? 'no students' : null,
      listing.working_only === true ? 'working applicants only' : null,
      eligibility.couples === 'no' ? 'no couples' : null,
      eligibility.pets === 'no' ? 'no pets' : null,
      listing.degree_restriction ? 'degree restriction' : null,
      listing.income_requirement ? 'income requirement' : null,
    ].filter(Boolean).join(', ') || (ad.restrictions.length ? ad.restrictions.length + ' terms found' : '—'),
    eligibility: Object.entries({ ...eligibility.tenants, couples: eligibility.couples, pets: eligibility.pets })
      .map(([name, answer]) => name + ':' + answer).join(' ') + ' (' + eligibility.basis + ')',
    precision: show(location.precision),
    coordinatesOrPostcode: location.lat !== null ? `${location.lat}, ${location.lng}` : location.postcode || '—',
    photos: ad.photos.length,
  };
}

async function verify(source) {
  const path = join(root, source.id);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const statePath = join(path, 'health.json');
  const previous = await state(statePath);
  const collected = localHealth(source.id);
  const due = Math.max(Date.parse(previous.nextCheckAt) || 0, Date.parse(collected.nextCheckAt) || 0);
  if (due > Date.now()) return { id: source.id, status: previous.status ?? collected.status, note: 'Backoff active', listings: [] };

  const captures = [];
  const errors = [];
  const listings = [];
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  let stage = 'index';
  const get = createSourceFetcher(source, {
    paceMs: 2000,
    onResponse: async ({ url, status, type, body }) => {
      const kind = new URL(url).pathname === '/robots.txt' ? 'robots' : stage;
      const extension = /json/.test(type ?? '') || /^\s*\{/.test(body) ? 'json' : /html/.test(type ?? '') ? 'html' : 'txt';
      const file = `${run}-${String(captures.length + 1).padStart(2, '0')}-${kind}.${extension}`;
      await writeFile(join(path, file), body, { mode: 0o600 });
      captures.push({ kind, status, file, url });
    },
  });
  const cap = singleProbe.has(source.id) ? 1 : 3;
  const queue = source.indexes.map((url) => new URL(url, source.origin).href);
  const visited = new Set();
  const candidates = new Map();
  let blocked;
  let blockedStatus;
  const allowedOrStop = async (work) => {
    try { return await work(); } catch (error) {
      if (error.status === 'blocked' || error.status === 'policy_blocked') {
        blocked = error;
        blockedStatus = error.status;
      }
      errors.push(error.httpStatus ? `HTTP ${error.httpStatus}` : error.message);
    }
  };
  for (let page = 0; queue.length && page < cap && !blocked;) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    page++;
    const index = await allowedOrStop(async () => parseIndex(source, await get(url), url));
    if (!index) continue;
    for (const item of index.candidates) candidates.set(item.url, item);
    queue.push(...index.next);
  }
  stage = 'detail';
  const detailCap = singleProbe.has(source.id) ? 0 : 5;
  for (const candidate of [...candidates.values()].slice(0, detailCap)) {
    if (blocked) break;
    if (candidate.inlineProperty) {
      const item = await allowedOrStop(() => parseDetail(source, '', candidate));
      if (item) listings.push(coverage(item));
      // The JSON offer itself is the detail object. Save the public detail page as evidence when available.
      await allowedOrStop(() => get(candidate.url));
    } else {
      const item = await allowedOrStop(async () => parseDetail(source, await get(candidate.url), candidate));
      if (item) listings.push(coverage(item));
    }
    if (listings.length >= 2) break;
  }
  const status = blockedStatus ? 'blocked' : listings.length >= 2 ? 'working' : 'partial';
  const failures = blocked ? (previous.failures ?? 0) + 1 : 0;
  const nextCheckAt = blocked
    ? new Date(Math.max(blocked.retryAt || 0, Date.now() + Math.min(360, 30 * 2 ** Math.min(4, failures - 1)) * 60_000)).toISOString()
    : errors.length ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
  const result = { id: source.id, status, failures, nextCheckAt, candidates: candidates.size, errors, captures, listings };
  await Promise.all([
    writeFile(statePath, JSON.stringify({ status, failures, nextCheckAt }), { mode: 0o600 }),
    writeFile(join(path, run + '-report.json'), JSON.stringify(result, null, 2), { mode: 0o600 }),
  ]);
  return result;
}

const args = process.argv.slice(2);
const named = args[0]?.match(/^--source=(.+)$/)?.[1]?.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const id = named === 'duwo' || named === 'room' ? 'roommatch' : named;
const selected = SOURCES.filter((source) => source.kind !== 'account' && (!id || id === source.id));
if (args.length > 1 || (args.length && !id) || !selected.length) {
  console.error('Usage: npm run verify:sources [-- --source=<source-id>]');
  process.exitCode = 1;
} else {
  const results = await Promise.allSettled(selected.map(verify));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.log(selected[index].id, 'partial', result.reason.message);
      process.exitCode = 1;
      continue;
    }
    const { id, status, candidates, errors, note, listings } = result.value;
    console.log(id, status, note ?? `${candidates} candidates, ${listings.length} parsed details`, errors?.join(' | ') ?? '');
    if (listings.length) console.table(listings);
  }
}
