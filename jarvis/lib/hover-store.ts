"use client";

import { useSyncExternalStore } from "react";

/**
 * Tiny external stores for high-frequency UI state. Keeping these in React state at the top
 * of the tree re-rendered every card and pin on each pointer move; with a store each card or
 * pin subscribes to "is this me?", so a change re-renders exactly two components.
 */
function createIdStore() {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(id: string | null) {
      if (id === value) return;
      value = id;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/** The card under the mouse (drives the map pin highlight). */
export const hoverStore = createIdStore();

/** The keyboard cursor in triage mode. Independent of DOM focus, so it is always visible. */
export const cursorStore = createIdStore();

function useIs(store: ReturnType<typeof createIdStore>, id: string) {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get() === id,
    () => false,
  );
}

export const useIsHovered = (id: string) => useIs(hoverStore, id);
export const useIsCursor = (id: string) => useIs(cursorStore, id);

/**
 * Hover can come from the user moving the mouse, or from the page moving under a still mouse
 * (scrolling, cards reflowing after save/pass). Only the first should steer the keyboard cursor
 * or the map highlight while triaging, so we remember when the mouse genuinely last moved.
 */
let lastRealMove = 0;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "mouse" && (e.movementX !== 0 || e.movementY !== 0)) lastRealMove = performance.now();
    },
    { passive: true, capture: true },
  );
}
/** True if the mouse itself moved recently and no page transition is running. */
export function pointerIntent(windowMs = 120) {
  if (typeof document !== "undefined" && document.documentElement.dataset.vt) return false;
  return performance.now() - lastRealMove < windowMs;
}
