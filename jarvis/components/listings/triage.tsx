"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { hoverStore } from "@/lib/hover-store";

/**
 * Keyboard triage for people going through many homes quickly. It stays invisible until an
 * arrow key is pressed, then the focused card is the cursor:
 *   ← → ↑ ↓ move · S save · D pass · E / Enter open · Z undo last pass · ? help · Esc leave
 */

const CARD = "[data-card-id]";

function cards() {
  return [...document.querySelectorAll<HTMLElement>(CARD)];
}

function focusCard(id: string | null | undefined) {
  if (!id) return;
  const el = document.querySelector<HTMLElement>(`${CARD}[data-card-id="${CSS.escape(id)}"]`);
  const target = el?.querySelector<HTMLElement>("h3 button");
  if (!el || !target) return;
  target.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  hoverStore.set(id);
}

function currentId() {
  return (document.activeElement?.closest(CARD) as HTMLElement | null)?.dataset.cardId ?? null;
}

/**
 * Spatial navigation from real geometry, so it works across both result grids, any column
 * count, and after the grid reflows. Left/Right follow reading order; Up/Down pick the
 * nearest card in the next row, preferring the same column.
 */
function neighbour(list: HTMLElement[], from: HTMLElement, key: string) {
  const i = list.indexOf(from);
  if (key === "ArrowRight") return list[Math.min(list.length - 1, i + 1)];
  if (key === "ArrowLeft") return list[Math.max(0, i - 1)];
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const down = key === "ArrowDown";
  let best: HTMLElement | null = null;
  let bestRow = Infinity;
  let bestDx = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const gap = down ? b.top - r.bottom : r.top - b.bottom;
    if (gap < -r.height / 2) continue; // not in the next row in that direction
    const row = Math.round(Math.max(0, gap) / 8); // same visual row ≈ same bucket
    const dx = Math.abs(b.left + b.width / 2 - cx);
    if (row < bestRow || (row === bestRow && dx < bestDx)) {
      best = el;
      bestRow = row;
      bestDx = dx;
    }
  }
  return best ?? from;
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  // Widgets that own the arrow keys themselves.
  return !!el.closest(
    "[role=dialog]:not([data-triage-ok]), .maplibregl-map, [role=slider], [role=radiogroup], [role=menu], [role=grid], [role=switch]",
  );
}

interface TriageOptions {
  enabled: boolean;
  onSave: (id: string) => void;
  /** Pass on a home; resolves the id to focus next. */
  onPass: (id: string) => void;
  onOpen: (id: string) => void;
  onUndo: () => void;
}

export function useTriage({ enabled, onSave, onPass, onOpen, onUndo }: TriageOptions) {
  const [active, setActive] = useState(false);
  const [help, setHelp] = useState(false);
  const handlers = useRef({ onSave, onPass, onOpen, onUndo });
  useEffect(() => {
    handlers.current = { onSave, onPass, onOpen, onUndo };
  }, [onSave, onPass, onOpen, onUndo]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      const list = cards();
      if (!list.length) return;
      const id = currentId();
      const key = e.key;

      if (key === "?") {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (key === "Escape") {
        if (help) setHelp(false);
        else if (active) {
          setActive(false);
          hoverStore.set(null);
          (document.activeElement as HTMLElement | null)?.blur();
        }
        return;
      }

      if (key.startsWith("Arrow")) {
        e.preventDefault();
        setActive(true);
        if (!id) {
          // Start where the person is looking: the hovered card, else the first visible one.
          const hovered = hoverStore.get();
          const start =
            list.find((c) => c.dataset.cardId === hovered) ??
            list.find((c) => c.getBoundingClientRect().bottom > 160) ??
            list[0];
          return focusCard(start.dataset.cardId);
        }
        const from = list.find((c) => c.dataset.cardId === id);
        if (!from) return focusCard(list[0].dataset.cardId);
        return focusCard(neighbour(list, from, key).dataset.cardId);
      }

      if (!id) return;
      const k = key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        setActive(true);
        handlers.current.onSave(id);
      } else if (k === "d") {
        e.preventDefault();
        setActive(true);
        const i = list.findIndex((c) => c.dataset.cardId === id);
        const next = list[i + 1] ?? list[i - 1];
        handlers.current.onPass(id);
        // The neighbour already exists; focusing it now keeps the cursor where the eye is.
        focusCard(next?.dataset.cardId);
      } else if (k === "e" || key === "Enter") {
        e.preventDefault();
        handlers.current.onOpen(id);
      } else if (k === "z") {
        e.preventDefault();
        handlers.current.onUndo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, active, help]);

  return { active, help, setHelp };
}

const KEYS: Array<[string[], string]> = [
  [["←", "→", "↑", "↓"], "Move between homes"],
  [["S"], "Save to shortlist"],
  [["D"], "Not for me"],
  [["E"], "Open"],
  [["Z"], "Undo last pass"],
  [["Esc"], "Stop"],
];

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="tabular inline-grid h-6 min-w-6 place-items-center rounded-md bg-white/15 px-1.5 font-sans text-[12px] font-semibold">
      {children}
    </kbd>
  );
}

/** A quiet hint bar while triaging, and a small sheet on `?`. */
export function TriageHint({ active, help, onClose }: { active: boolean; help: boolean; onClose: () => void }) {
  return (
    <>
      <div
        aria-hidden={!active}
        className={cn(
          "pointer-events-none fixed inset-x-0 bottom-6 z-40 hidden justify-center transition-[opacity,translate] duration-200 ease-[var(--ease-out)] lg:flex",
          active && !help ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        )}
      >
        <div className="flex items-center gap-4 rounded-full bg-ink px-4 py-2.5 text-[13px] text-white shadow-[var(--shadow-sheet)]">
          {KEYS.slice(0, 5).map(([keys, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              {keys.map((k) => (
                <Key key={k}>{k}</Key>
              ))}
              <span className="text-white/75">{label}</span>
            </span>
          ))}
          <span className="text-white/50">? for help</span>
        </div>
      </div>

      {help && (
        <div
          role="dialog"
          data-triage-ok
          aria-label="Keyboard shortcuts"
          className="hw-swap fixed bottom-6 left-1/2 z-50 w-[min(360px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl bg-ink p-5 text-white shadow-[var(--shadow-sheet)]"
        >
          <div className="mb-3 flex items-baseline justify-between">
            <p className="text-[15px] font-semibold">Quick triage</p>
            <button type="button" onClick={onClose} className="text-[13px] text-white/70 underline underline-offset-4">
              Close
            </button>
          </div>
          <ul className="space-y-2.5">
            {KEYS.map(([keys, label]) => (
              <li key={label} className="flex items-center justify-between gap-4 text-[14px]">
                <span className="text-white/80">{label}</span>
                <span className="flex gap-1">
                  {keys.map((k) => (
                    <Key key={k}>{k}</Key>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[12px] leading-4 text-white/60">
            Press an arrow key on the results to start. Saved and passed homes stay private to you.
          </p>
        </div>
      )}
    </>
  );
}
