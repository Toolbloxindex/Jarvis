"use client";

import { applyRemote, onLocalWrite, readPersisted } from "./persist.ts";

/**
 * Account-free sync between devices (see docs/SYNC-PLAN.md).
 *
 * Identity is a random secret key kept in this browser (localStorage + a long-lived first-party
 * cookie set by the server, which survives Safari's 7-day cap on script-written storage). The
 * database stores only its hash and is reached directly from the browser through Supabase RPCs, so
 * syncing costs no Vercel CPU.
 *
 * Every synced field is kept in a timestamped document, so any two copies merge the same way:
 *   - sets (saved, passed): per home, the latest add/remove wins (removals are kept as tombstones);
 *   - maps (notes, checklists): per home, the latest edit wins;
 *   - values (search, filters, sort): the latest change wins.
 * Layout toggles (map, filters panel) stay per device on purpose: a phone is not a laptop.
 */

const SETS = ["saved", "passed"] as const;
const MAPS = ["notes", "checked"] as const;
const VALUES = ["search", "filters", "sort"] as const;
type SyncedKey = (typeof SETS)[number] | (typeof MAPS)[number] | (typeof VALUES)[number];
const kindOf = (key: string): "set" | "map" | "value" | null =>
  (SETS as readonly string[]).includes(key)
    ? "set"
    : (MAPS as readonly string[]).includes(key)
      ? "map"
      : (VALUES as readonly string[]).includes(key)
        ? "value"
        : null;

type SetEntry = { on: boolean; t: number };
type MapEntry = { v: unknown; t: number };
export interface SyncDoc {
  s?: Partial<Record<string, Record<string, SetEntry>>>;
  m?: Partial<Record<string, Record<string, MapEntry>>>;
  v?: Partial<Record<string, MapEntry>>;
}

const DOC_KEY = "hw:sync:doc";
const KEY_KEY = "hw:sync:key";
const VERSION_KEY = "hw:sync:version";
const TOMBSTONE_MS = 90 * 24 * 3600 * 1000;

/* ---------- pure document logic (exported for tests) ---------- */

/** JSON with sorted keys: Postgres jsonb reorders keys, so plain JSON.stringify is not comparable. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** Later timestamp wins; ties break deterministically so every device converges. */
const newer = <E extends { t: number }>(a: E | undefined, b: E | undefined) =>
  !a ? b : !b ? a : a.t !== b.t ? (a.t > b.t ? a : b) : canonical(a) >= canonical(b) ? a : b;

function mergeRecords<E extends { t: number }>(a: Record<string, E> = {}, b: Record<string, E> = {}) {
  const out: Record<string, E> = { ...a };
  for (const [id, entry] of Object.entries(b)) out[id] = newer(out[id], entry)!;
  return out;
}

export function mergeDocs(a: SyncDoc, b: SyncDoc): SyncDoc {
  const out: SyncDoc = { s: {}, m: {}, v: {} };
  for (const k of new Set([...Object.keys(a.s ?? {}), ...Object.keys(b.s ?? {})])) out.s![k] = mergeRecords(a.s?.[k], b.s?.[k]);
  for (const k of new Set([...Object.keys(a.m ?? {}), ...Object.keys(b.m ?? {})])) out.m![k] = mergeRecords(a.m?.[k], b.m?.[k]);
  for (const k of new Set([...Object.keys(a.v ?? {}), ...Object.keys(b.v ?? {})])) out.v![k] = newer(a.v?.[k], b.v?.[k])!;
  return out;
}

/** Record a local change to `key` (its full new value) in the document. */
export function stamp(doc: SyncDoc, key: string, next: unknown, t: number): SyncDoc {
  const kind = kindOf(key);
  if (!kind) return doc;
  const out: SyncDoc = { s: { ...doc.s }, m: { ...doc.m }, v: { ...doc.v } };
  if (kind === "set") {
    const ids = new Set(Array.isArray(next) ? (next as string[]) : []);
    const rec = { ...out.s![key] };
    for (const id of ids) if (!rec[id]?.on) rec[id] = { on: true, t };
    for (const [id, e] of Object.entries(rec)) if (e.on && !ids.has(id)) rec[id] = { on: false, t };
    out.s![key] = rec;
  } else if (kind === "map") {
    const value = (next && typeof next === "object" ? next : {}) as Record<string, unknown>;
    const rec = { ...out.m![key] };
    for (const [id, v] of Object.entries(value)) if (!same(rec[id]?.v, v)) rec[id] = { v, t };
    for (const [id, e] of Object.entries(rec)) if (e.v !== null && !(id in value)) rec[id] = { v: null, t };
    out.m![key] = rec;
  } else if (!same(out.v![key]?.v, next)) {
    out.v![key] = { v: next, t };
  }
  return out;
}

/** The plain value a key should have locally, or undefined when the document has nothing for it. */
export function valueOf(doc: SyncDoc, key: SyncedKey): unknown {
  const kind = kindOf(key);
  if (kind === "set") {
    const rec = doc.s?.[key];
    if (!rec) return undefined;
    return Object.entries(rec)
      .filter(([, e]) => e.on)
      .sort((a, b) => a[1].t - b[1].t)
      .map(([id]) => id);
  }
  if (kind === "map") {
    const rec = doc.m?.[key];
    if (!rec) return undefined;
    return Object.fromEntries(Object.entries(rec).filter(([, e]) => e.v !== null).map(([id, e]) => [id, e.v]));
  }
  return doc.v?.[key]?.v;
}

/** Drop removals older than 90 days so the document does not grow forever. */
export function prune(doc: SyncDoc, now: number): SyncDoc {
  const cut = now - TOMBSTONE_MS;
  const out: SyncDoc = { s: {}, m: {}, v: { ...doc.v } };
  for (const [k, rec] of Object.entries(doc.s ?? {}))
    out.s![k] = Object.fromEntries(Object.entries(rec ?? {}).filter(([, e]) => e.on || e.t > cut));
  for (const [k, rec] of Object.entries(doc.m ?? {}))
    out.m![k] = Object.fromEntries(Object.entries(rec ?? {}).filter(([, e]) => e.v !== null || e.t > cut));
  return out;
}

/* ---------- local storage of the document, key and version ---------- */

function load<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage full or disabled: sync still works for this session
  }
}

let lastT = 0;
const clock = () => (lastT = Math.max(Date.now(), lastT + 1));

/** First run on this browser: describe what is already stored, as old (t=1) so remote edits win. */
function seedDoc(): SyncDoc {
  let doc: SyncDoc = {};
  for (const key of [...SETS, ...MAPS, ...VALUES]) {
    const value = readPersisted<unknown>(key, undefined);
    if (value !== undefined) doc = stamp(doc, key, value, 1);
  }
  return doc;
}
const loadDoc = (): SyncDoc => load<SyncDoc | null>(DOC_KEY, null) ?? seedDoc();

function applyDoc(doc: SyncDoc) {
  for (const key of [...SETS, ...MAPS, ...VALUES]) {
    const value = valueOf(doc, key);
    if (value !== undefined && !same(value, readPersisted<unknown>(key, undefined))) applyRemote(key, value);
  }
}

const newKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const cookieKey = () => document.cookie.match(/(?:^|; )hw_sync=([A-Za-z0-9_-]{32,128})/)?.[1] ?? null;

/** Persist the key in a server-set cookie too (script-set cookies expire after 7 days in Safari). */
function rememberKey(key: string) {
  save(KEY_KEY, key);
  if (cookieKey() !== key) {
    void fetch("/api/sync-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }).catch(() => {});
  }
}

/* ---------- status (for the header control) ---------- */

export type SyncPhase = "off" | "syncing" | "synced" | "offline";
export interface SyncStatus {
  phase: SyncPhase;
  at: number | null;
}
const SERVER_STATUS: SyncStatus = { phase: "off", at: null };
let status: SyncStatus = SERVER_STATUS;
const statusListeners = new Set<() => void>();
function setStatus(phase: SyncPhase) {
  status = { phase, at: phase === "synced" ? Date.now() : status.at };
  for (const l of statusListeners) l();
}
export const syncStatusStore = {
  subscribe(l: () => void) {
    statusListeners.add(l);
    return () => void statusListeners.delete(l);
  },
  get: () => status,
  server: (): SyncStatus => SERVER_STATUS,
};

/* ---------- network ---------- */

export interface SyncConfig {
  url: string;
  anonKey: string;
}
let config: SyncConfig | null = null;
let key = "";

/** Access token of the optional email account (lib/account.ts); null = anonymous. */
let authToken: string | null = null;
export function setSyncAuthToken(token: string | null) {
  authToken = token;
}

async function rpc<T>(fn: string, body: Record<string, unknown>, keepalive = false): Promise<T> {
  if (!config) throw new Error("sync is not configured");
  const headers: Record<string, string> = { apikey: config.anonKey, "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(`${config.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) throw new Error(`sync ${fn} failed (${res.status})`);
  return (await res.json()) as T;
}

type PullResult = { data: SyncDoc; version: number };
type PushResult = { ok: true; version: number } | { ok: false; data: SyncDoc; version: number };

let chain: Promise<void> = Promise.resolve();
/** Network operations run one at a time, in order. */
const serial = (op: () => Promise<void>) =>
  (chain = chain.then(op).catch(() => {
    setStatus("offline");
  }));

function adopt(remote: SyncDoc, version: number) {
  const merged = mergeDocs(loadDoc(), remote);
  save(DOC_KEY, merged);
  save(VERSION_KEY, version);
  applyDoc(merged);
  return merged;
}

async function pushNow() {
  setStatus("syncing");
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = prune(loadDoc(), Date.now());
    const res = await rpc<PushResult>("sync_push", { p_key: key, p_data: doc, p_base: load(VERSION_KEY, 0) });
    if (res.ok) {
      save(VERSION_KEY, res.version);
      setStatus("synced");
      return;
    }
    adopt(res.data, res.version); // someone else wrote first: merge and try again
  }
  throw new Error("sync kept conflicting");
}

async function pullNow() {
  setStatus("syncing");
  const res = await rpc<PullResult>("sync_pull", { p_key: key });
  const local = loadDoc();
  if (res.version === load(VERSION_KEY, 0) && same(prune(local, Date.now()), res.data)) {
    setStatus("synced");
    return;
  }
  const merged = adopt(res.data, res.version);
  if (!same(merged, res.data)) await pushNow();
  else setStatus("synced");
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePush(delay = 1500) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    serial(pushNow);
  }, delay);
}

let lastPull = 0;
function pullSoon() {
  if (Date.now() - lastPull < 10_000) return;
  lastPull = Date.now();
  serial(pullNow);
}

/* ---------- lifecycle ---------- */

let started = false;
export function startSync(cfg: SyncConfig) {
  if (started || typeof window === "undefined") return () => {};
  started = true;
  config = cfg;
  key = load<string | null>(KEY_KEY, null) ?? cookieKey() ?? newKey();
  rememberKey(key);
  if (!localStorage.getItem(DOC_KEY)) save(DOC_KEY, seedDoc());

  onLocalWrite((k, _prev, next) => {
    if (!kindOf(k)) return;
    save(DOC_KEY, stamp(loadDoc(), k, next, clock()));
    setStatus("syncing");
    schedulePush();
  });

  const onVisible = () => {
    if (document.visibilityState === "visible") pullSoon();
    else if (pushTimer) {
      // Leaving the page: send pending edits now, best effort.
      clearTimeout(pushTimer);
      pushTimer = null;
      void rpc("sync_push", { p_key: key, p_data: prune(loadDoc(), Date.now()), p_base: load(VERSION_KEY, 0) }, true)
        .then((r) => {
          const res = r as PushResult;
          if (res.ok) save(VERSION_KEY, res.version);
        })
        .catch(() => {});
    }
  };
  const onFocus = () => pullSoon();
  const onOnline = () => serial(pullNow);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onOnline);
  const poll = setInterval(() => {
    if (document.visibilityState === "visible") pullSoon();
  }, 60_000);

  lastPull = Date.now();
  serial(pullNow);

  return () => {
    started = false;
    onLocalWrite(null);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onOnline);
    clearInterval(poll);
  };
}

/* ---------- pairing ---------- */

export interface PairCode {
  code: string;
  expiresAt: string;
}
export const createPairCode = () => rpc<PairCode>("sync_pair_create", { p_key: key });

export type ClaimResult = "linked" | "already" | "invalid";
/** Join the devices that created `code`: this browser's data is merged into theirs. */
export async function claimPairCode(code: string): Promise<ClaimResult> {
  const claimed = await rpc<string | null>("sync_pair_claim", { p_code: code });
  if (!claimed) return "invalid";
  return adoptKey(claimed);
}

/**
 * Switch this browser to another device group's key (pairing code or email sign-in). Nothing is
 * lost: this browser's list is merged into theirs and pushed back.
 */
export async function adoptKey(next: string): Promise<"linked" | "already"> {
  if (next === key) return "already";
  setKey(next);
  save(VERSION_KEY, 0);
  await new Promise<void>((resolve) => serial(pullNow).then(resolve));
  return "linked";
}

/** Stop syncing with the other devices. This browser keeps a private copy under a new key. */
export async function unlinkDevice() {
  setKey(newKey());
  save(VERSION_KEY, 0);
  await new Promise<void>((resolve) => serial(pushNow).then(resolve));
}

/** This browser's sync key ("" before sync starts). It is a secret: send it only to Supabase. */
export const currentSyncKey = () => key;
/** The configured Supabase settings (null before sync starts). */
export const syncConfig = () => config;
export { rpc as syncRpc };

type KeyListener = (next: string, previous: string) => void;
const keyListeners = new Set<KeyListener>();
/** Notified when this browser moves to another key (pairing, email sign-in, unlink). */
export function onSyncKeyChange(listener: KeyListener) {
  keyListeners.add(listener);
  return () => void keyListeners.delete(listener);
}
function setKey(next: string) {
  const previous = key;
  key = next;
  rememberKey(key);
  for (const l of keyListeners) l(next, previous);
}
