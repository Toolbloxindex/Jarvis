"use client";

import { flushSync } from "react-dom";

/**
 * View Transitions snapshot the page and animate the snapshots on the compositor, so a
 * reflowing grid or a card growing into a sheet stays smooth even when the main thread is
 * busy rendering React. Browsers without support (or people who prefer reduced motion)
 * get the same state change, instantly.
 *
 * `kind` is written to <html data-vt> for the duration, so CSS can decide which elements
 * take part (see globals.css). Only one transition runs at a time; a newer one skips the older.
 */
export type TransitionKind = "results" | "detail";

let token = 0;

export function canAnimate() {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function runTransition(
  kind: TransitionKind,
  update: () => void,
  hooks: { before?: () => void; afterUpdate?: () => void | Promise<void>; done?: () => void } = {},
) {
  if (!canAnimate()) {
    update();
    hooks.afterUpdate?.();
    hooks.done?.();
    return;
  }
  const mine = ++token;
  const root = document.documentElement;
  root.dataset.vt = kind;
  hooks.before?.();
  const vt = document.startViewTransition(async () => {
    flushSync(update);
    await hooks.afterUpdate?.();
  });
  // A newer transition skips this one; that rejection is expected, not an error.
  vt.ready.catch(() => {});
  vt.updateCallbackDone.catch(() => {});
  vt.finished.finally(() => {
    if (mine === token) delete root.dataset.vt;
    hooks.done?.();
  }).catch(() => {});
}

/** Wait for an image to be decoded, but never hold a transition for more than `ms`. */
export function decodeWithin(img: HTMLImageElement | null | undefined, ms = 120) {
  if (!img) return Promise.resolve();
  return Promise.race([img.decode().catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
}
