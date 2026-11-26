"use client";

/**
 * The two ways a card leaves the grid, as one-off keyframes on its view-transition snapshot.
 * Transform + opacity only, so the browser runs them on the compositor; the grid closing the gap
 * is the regular view transition around them. Each returns a <style> to insert before the
 * transition starts and remove when it ends.
 */

const sel = (id: string) => `html:root[data-vt]::view-transition-old(card-${CSS.escape(id)}):only-child`;
let n = 0;

/** Saving: a small lift, then an arc into the header button (Saved), landing tiny. */
export function flyIntoStyle(id: string, binId: string) {
  const style = document.createElement("style");
  const card = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const bin = document.getElementById(binId)?.getBoundingClientRect();
  if (!card || !bin || bin.width === 0) {
    style.textContent = `${sel(id)}{opacity:1;animation:hw-drop 200ms cubic-bezier(0.4,0,0.2,1) both}`;
    return style;
  }
  const dx = bin.left + bin.width / 2 - (card.left + card.width / 2);
  const dy = bin.top + bin.height / 2 - (card.top + card.height / 2);
  const k = `hw-fly-${++n}`;
  style.textContent = `
    @keyframes ${k} {
      0% { transform: none; opacity: 1; }
      18% { transform: translateY(-6px) scale(1.02); opacity: 1; }
      62% { transform: translate(${(dx * 0.55).toFixed(1)}px, ${(dy * 0.5 - 28).toFixed(1)}px) scale(0.32); opacity: 1; }
      100% { transform: translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(0.06); opacity: 0.5; }
    }
    html::view-transition-group(card-${CSS.escape(id)}) { z-index: 50; }
    ${sel(id)} { opacity: 1; animation: ${k} 460ms cubic-bezier(0.5, 0, 0.2, 1) both; transform-origin: 50% 40%; }`;
  return style;
}

/** Passing: a quick drop-and-fade in place. Short, so triage stays fast. */
export function dropStyle(id: string) {
  const style = document.createElement("style");
  style.textContent = `${sel(id)}{opacity:1;animation:hw-drop 190ms cubic-bezier(0.4,0,0.2,1) both}`;
  return style;
}
