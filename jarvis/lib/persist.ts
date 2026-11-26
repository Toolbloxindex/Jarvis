"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Local-first persistence: every piece of personal state (saved, passed, notes, search…) lives in
 * localStorage under a versioned key, so a reload or a new tab picks up exactly where you were.
 * Built on useSyncExternalStore: the server renders the defaults, the browser then shows the stored
 * value without a hydration mismatch, and other tabs stay in sync through the `storage` event.
 *
 * A device id cookie (`hw_device`) identifies this browser without an account; it is the anchor
 * for syncing with Supabase later.
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
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: T = fallback;
  if (raw !== null) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = fallback;
    }
  }
  cache.set(key, { raw, value });
  return value;
}

function write<T>(key: string, value: T) {
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

/** Anonymous device id, created once and kept for two years. No account, no personal data. */
export function ensureDeviceId() {
  if (typeof document === "undefined") return null;
  const found = document.cookie.match(/(?:^|; )hw_device=([^;]+)/)?.[1];
  if (found) return found;
  const id = crypto.randomUUID();
  document.cookie = `hw_device=${id}; Max-Age=${60 * 60 * 24 * 730}; Path=/; SameSite=Lax; Secure`;
  return id;
}
