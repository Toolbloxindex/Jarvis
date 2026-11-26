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
export type TransitionKind = "results" | "layout" | "detail";

/**
 * Snapshotting is the expensive part of a view transition, so only cards near the viewport take
 * part (offscreen cards just update). Returns a cleanup.
 */
function nameVisibleCards() {
  const margin = window.innerHeight * 0.5;
  const named: Element[] = [];
  for (const el of document.querySelectorAll(".hw-card")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > -margin && r.top < window.innerHeight + margin) {
      el.classList.add("vt-on");
      named.push(el);
    }
  }
  return () => {
    for (const el of named) el.classList.remove("vt-on");
  };
}

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
  const unname = kind === "detail" ? null : nameVisibleCards();
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
    unname?.();
    hooks.done?.();
  }).catch(() => {});
}

/** Wait for an image to be decoded, but never hold a transition for more than `ms`. */
export function decodeWithin(img: HTMLImageElement | null | undefined, ms = 120) {
  if (!img) return Promise.resolve();
  return Promise.race([img.decode().catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
}
