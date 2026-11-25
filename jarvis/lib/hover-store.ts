"use client";

import { useSyncExternalStore } from "react";

/**
 * Hovering a card highlights its map pin. Keeping that in React state at the top of the tree
 * re-rendered every card and pin on each pointer move. This tiny store lets each pin subscribe
 * to "am I hovered?", so a hover re-renders exactly two pins.
 */
type Listener = () => void;

let hovered: string | null = null;
const listeners = new Set<Listener>();

export const hoverStore = {
  get: () => hovered,
  set(id: string | null) {
    if (id === hovered) return;
    hovered = id;
    for (const l of listeners) l();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useIsHovered(id: string) {
  return useSyncExternalStore(
    hoverStore.subscribe,
    () => hovered === id,
    () => false,
  );
}
