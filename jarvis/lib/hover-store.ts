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
