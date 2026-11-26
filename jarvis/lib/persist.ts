"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Local-first persistence: every piece of personal state (saved, passed, notes, search…) lives in
 * localStorage under a versioned key, so a reload or a new tab picks up exactly where you were.
 * Built on useSyncExternalStore: the server renders the defaults, the browser then shows the stored
 * value without a hydration mismatch, and other tabs stay in sync through the `storage` event.
 *
 * Cross-device sync (lib/sync.ts) hooks in here: every local write is reported to it so it can be
 * timestamped and pushed, and values that arrive from another device are applied with `applyRemote`,
 * which does not report back.
 */

const PREFIX = "hw:v1:";
const listeners = new Map<string, Set<() => void>>();
const cache = new Map<string, { raw: string | null; value: unknown }>();

function notify(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key?.startsWith(PREFIX)) notify(e.key.slice(PREFIX.length));
  });
}

function read<T>(key: string, fallback: T): T {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFIX + key);
  } catch {
    return fallback; // storage disabled (private mode, policy): behave like a fresh visit
  }
  // Nothing stored: each caller gets its own default (never cache one caller's fallback for another).
  if (raw === null) return fallback;
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
  cache.set(key, { raw, value });
  return value;
}

type WriteHook = (key: string, prev: unknown, next: unknown) => void;
let writeHook: WriteHook | null = null;
/** Register the sync layer's listener for local writes. */
export function onLocalWrite(hook: WriteHook | null) {
  writeHook = hook;
}

/** Read a persisted value outside React (sync layer). */
export function readPersisted<T>(key: string, fallback: T): T {
  return read(key, fallback);
}

/** Apply a value that came from another device: stored and rendered, but not reported as a local edit. */
export function applyRemote<T>(key: string, value: T) {
  write(key, value, false);
}

function write<T>(key: string, value: T, local = true) {
  if (local && writeHook) writeHook(key, cache.get(key)?.value, value);
  const raw = JSON.stringify(value);
  cache.set(key, { raw, value });
  try {
    localStorage.setItem(PREFIX + key, raw);
  } catch {
    // quota or disabled storage: keep the in-memory value for this session
  }
  notify(key);
}

export function usePersisted<T>(key: string, initial: T) {
  const subscribe = useCallback(
    (l: () => void) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(l);
      return () => {
        listeners.get(key)?.delete(l);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, initial),
    () => initial,
  );
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = read(key, initial);
      write(key, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
    },
    // `initial` is a constant per call site; keying on `key` keeps the setter stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set] as const;
}

/** A persisted Set<string> with the same updater API as useState<Set>. */
export function usePersistedSet(key: string) {
  const [list, setList] = usePersisted<string[]>(key, EMPTY);
  const set = useCallback(
    (next: ReadonlySet<string> | ((prev: ReadonlySet<string>) => ReadonlySet<string>)) =>
      setList((prev) => [...(typeof next === "function" ? next(new Set(prev)) : next)]),
    [setList],
  );
  return [list, set] as const;
}
const EMPTY: string[] = [];
