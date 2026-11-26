"use client";

import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { cursorStore, hoverStore, pointerIntent } from "@/lib/hover-store";

/**
 * Keyboard triage for going through many homes quickly. Invisible until an arrow key is
 * pressed. The cursor is explicit state (not DOM focus), so it is always visible and survives
 * clicks on filters, the map or a slider:
 *   ← → ↑ ↓ move · S save · D pass · E open/close · Z undo last pass · ? help · Esc leave
 */

/** Navigable cards: visible, and not on their way out (a save/pass animation in flight). */
const CARD = "[data-card-id]:not([hidden]):not([data-leaving])";
const cards = () => [...document.querySelectorAll<HTMLElement>(CARD)];
const byId = (id: string | null) =>
  id ? document.querySelector<HTMLElement>(`${CARD}[data-card-id="${CSS.escape(id)}"]`) : null;

function show(id: string | null | undefined, instant = false) {
  if (!id) return;
  const el = byId(id);
  if (!el) return;
  cursorStore.set(id);
  hoverStore.set(id);
  // Scroll only when the card is not fully visible below the sticky header. Held keys jump
  // instantly so smooth scrolls never pile up.
  const r = el.getBoundingClientRect();
  const top = (document.querySelector<HTMLElement>("[data-sticky-top]")?.getBoundingClientRect().bottom ?? 0) + 12;
  const bottom = window.innerHeight - 16;
  const dy = r.top < top ? r.top - top : r.bottom > bottom ? Math.min(r.bottom - bottom, r.top - top) : 0;
  if (dy !== 0) {
    const smooth = !instant && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollBy({ top: dy, behavior: smooth ? "smooth" : "instant" });
  }
  // Keep assistive tech in sync without letting focus rings fight the cursor.
  el.querySelector<HTMLElement>("h3 button")?.focus({ preventScroll: true });
}

/**
 * Spatial navigation from real geometry: works across both result grids, any column count,
 * and after reflows. Left/Right follow reading order; Up/Down pick the nearest card in the
 * next row, preferring the same column.
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
    if (gap < -r.height / 2) continue;
    const row = Math.round(Math.max(0, gap) / 8);
    const dx = Math.abs(b.left + b.width / 2 - cx);
    if (row < bestRow || (row === bestRow && dx < bestDx)) {
      best = el;
      bestRow = row;
      bestDx = dx;
    }
  }
  return best ?? from;
}

/** Text entry always wins. Widgets that own arrows win too, unless the pointer is on a tile. */
function blocked(target: EventTarget | null, pointerOnTile: boolean) {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  if (el.closest("[role=dialog]:not([data-triage-ok]), [role=menu], [role=listbox]")) return true;
  if (pointerOnTile) return false;
  return !!el.closest(".maplibregl-map, [role=slider], [role=radiogroup], [role=grid], [role=switch], [role=tablist]");
}

interface TriageOptions {
  enabled: boolean;
  onSave: (id: string) => void;
  onPass: (id: string) => void;
  onOpen: (id: string) => void;
  onUndo: () => void;
}

export function useTriage({ enabled, onSave, onPass, onOpen, onUndo }: TriageOptions) {
  const [help, setHelp] = useState(false);
  const active = useSyncExternalStore(
    cursorStore.subscribe,
    () => cursorStore.get() !== null,
    () => false,
  );
  const handlers = useRef({ onSave, onPass, onOpen, onUndo });
  useEffect(() => {
    handlers.current = { onSave, onPass, onOpen, onUndo };
  }, [onSave, onPass, onOpen, onUndo]);

  // While triaging, moving the mouse onto a tile hands the cursor to it (real moves only).
  useEffect(
    () =>
      hoverStore.subscribe(() => {
        const h = hoverStore.get();
        if (h && cursorStore.get() !== null && pointerIntent()) cursorStore.set(h);
      }),
    [],
  );

  // Spotlight: while a cursor exists, other cards step back (CSS on html[data-triage]).
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.dataset.triage = "";
    else delete root.dataset.triage;
    return () => {
      delete root.dataset.triage;
    };
  }, [active]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const hovered = hoverStore.get();
      const pointerOnTile = !!hovered && !!byId(hovered);
      if (blocked(e.target, pointerOnTile)) return;
      const list = cards();
      if (!list.length) return;
      const key = e.key;
      let id = cursorStore.get();
      if (id && !byId(id)) id = null; // the card left the grid

      if (key === "?") {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (key === "Escape") {
        if (help) setHelp(false);
        else if (id) {
          cursorStore.set(null);
          (document.activeElement as HTMLElement | null)?.blur();
        }
        return;
      }

      if (key.startsWith("Arrow")) {
        e.preventDefault();
        if (!id) {
          // First press selects where the person is looking: the hovered tile, else the first visible one.
          const start =
            (pointerOnTile ? byId(hovered) : null) ??
            list.find((c) => c.getBoundingClientRect().bottom > 160) ??
            list[0];
          return show(start.dataset.cardId);
        }
        return show(neighbour(list, byId(id)!, key).dataset.cardId, e.repeat);
      }

      const k = key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        handlers.current.onUndo();
        return;
      }
      const target = id ?? (pointerOnTile ? hovered : null);
      if (!target) return;
      if (k === "s" || k === "d") {
        e.preventDefault();
        const i = list.findIndex((c) => c.dataset.cardId === target);
        const next = list[i + 1] ?? list[i - 1];
        // Take the card out of navigation now; it is still animating out for a few hundred ms.
        const leaving = byId(target);
        if (leaving) {
          leaving.dataset.leaving = "";
          window.setTimeout(() => delete leaving.dataset.leaving, 1200);
        }
        if (k === "s") handlers.current.onSave(target);
        else handlers.current.onPass(target);
        // Both actions take the card out of the feed: keep the cursor where the eye is.
        if (next) show(next.dataset.cardId);
      } else if (k === "e" || key === "Enter") {
        e.preventDefault();
        handlers.current.onOpen(target);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, help]);

  return { active, help, setHelp };
}

const KEYS: Array<[string[], string]> = [
  [["←", "→", "↑", "↓"], "Move"],
  [["S"], "Save"],
  [["D"], "Not for me"],
  [["E"], "Open"],
  [["Z"], "Undo pass"],
  [["Esc"], "Stop"],
];

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="tabular inline-grid h-6 min-w-6 place-items-center rounded-md bg-white/15 px-1.5 font-sans text-[12px] font-semibold">
      {children}
    </kbd>
  );
}

const DISMISS_KEY = "hw-triage-hint-dismissed";
const subscribeNoop = () => () => {};

/** A quiet, dismissible hint bar while triaging, and a small sheet on `?`. */
export function TriageHint({ active, help, onClose }: { active: boolean; help: boolean; onClose: () => void }) {
  const stored = useSyncExternalStore(
    subscribeNoop,
    () => localStorage.getItem(DISMISS_KEY) === "1",
    () => true,
  );
  const [override, setOverride] = useState<boolean | null>(null);
  const dismissed = override ?? stored;
  const visible = active && !help && !dismissed;

  return (
    <>
      <div
        aria-hidden={!visible}
        className={cn(
          "hw-hint fixed inset-x-0 bottom-6 z-40 hidden justify-center transition-[opacity,translate] duration-200 ease-[var(--ease-out)] lg:flex",
          visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        <div className="flex items-center gap-4 rounded-full bg-ink py-2 pr-2 pl-4 text-[13px] text-white shadow-[var(--shadow-sheet)]">
          {KEYS.slice(0, 5).map(([keys, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              {keys.map((k) => (
                <Key key={k}>{k}</Key>
              ))}
              <span className="text-white/75">{label}</span>
            </span>
          ))}
          <button
            type="button"
            aria-label="Hide keyboard hints (press ? to see them again)"
            tabIndex={visible ? 0 : -1}
            onClick={() => {
              setOverride(true);
              localStorage.setItem(DISMISS_KEY, "1");
            }}
            className="press grid size-7 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/15 hover:text-white"
          >
            <XIcon size={13} weight="bold" />
          </button>
        </div>
      </div>

      {help && (
        <div
          role="dialog"
          data-triage-ok
          aria-label="Keyboard shortcuts"
          className="hw-hint-help hw-swap fixed bottom-6 left-1/2 z-50 w-[min(340px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl bg-ink p-5 text-white shadow-[var(--shadow-sheet)]"
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[15px] font-semibold">Keyboard</p>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="press grid size-7 place-items-center rounded-full text-white/70 hover:bg-white/15 hover:text-white"
            >
              <XIcon size={13} weight="bold" />
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
          {dismissed && (
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem(DISMISS_KEY);
                setOverride(false);
                onClose();
              }}
              className="mt-4 text-[12px] text-white/60 underline underline-offset-4"
            >
              Show the hint bar again
            </button>
          )}
        </div>
      )}
    </>
  );
}
