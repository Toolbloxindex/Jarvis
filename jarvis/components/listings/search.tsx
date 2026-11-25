"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Slider } from "@base-ui/react/slider";
import NumberFlow from "@number-flow/react";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { startTransition, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatDay, formatEUR, formatMonths } from "@/lib/listings/format";
import { checkMoveIn, checkStay, monthlyTotal } from "@/lib/listings/match";
import { priceHistogram } from "@/lib/listings/query";
import type { Listing, SearchCriteria } from "@/lib/listings/types";
import { MoveInCalendar } from "./move-in-calendar";

type Segment = "moveIn" | "stay" | "budget";
const SEGMENTS: Segment[] = ["moveIn", "stay", "budget"];

const BUDGET_MIN = 400;
const BUDGET_MAX = 2500;
const BUDGET_STEP = 25;

interface SearchProps {
  criteria: SearchCriteria;
  /** Discrete changes (a chip, a date). Animated by the caller. */
  onChange: (next: SearchCriteria) => void;
  /** Continuous changes (dragging the budget). Never animated. */
  onChangeLive?: (next: SearchCriteria) => void;
  listings: Listing[];
  now: string;
  /** Months shown in the calendar. */
  months?: 1 | 2;
}

/* ------------------------------------------------------------------ */
/* Summaries                                                            */
/* ------------------------------------------------------------------ */

const today = (now: string) => now.slice(0, 10);

/** "As soon as possible" in practice means within a couple of weeks. */
export function asapDate(now: string) {
  const d = new Date(`${today(now)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 14);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function moveInSummary(moveInBy: string | null, now: string) {
  if (moveInBy === null) return "Any date";
  if (moveInBy === asapDate(now)) return "As soon as possible";
  return `By ${formatDay(moveInBy, now)}`;
}

export function staySummary(months: number | null) {
  return months === null ? "Flexible" : formatMonths(months);
}

export function budgetSummary(budget: number | null) {
  return budget === null ? "Any budget" : `Up to ${formatEUR(budget)}`;
}

const homes = (n: number) => (n === 1 ? "1 home" : `${n} homes`);

/* ------------------------------------------------------------------ */
/* Panels (shared by the desktop pill and the mobile sheet)             */
/* ------------------------------------------------------------------ */

function Chip({
  selected,
  onClick,
  children,
  hint,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "press flex flex-col items-start rounded-2xl px-4 py-3 text-left transition-colors duration-150",
        selected
          ? "bg-ink text-white"
          : "bg-white shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-ink)]",
      )}
    >
      <span className="text-[15px] font-semibold">{children}</span>
      {hint && (
        <span className={cn("tabular mt-0.5 text-[13px]", selected ? "text-white/70" : "text-ink-2")}>{hint}</span>
      )}
    </button>
  );
}

export function MoveInPanel({ criteria, onChange, listings, now, months = 2 }: SearchProps) {
  const availability = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of listings) map[l.tenancy.availableFrom] = (map[l.tenancy.availableFrom] ?? 0) + 1;
    return map;
  }, [listings]);
  const asap = asapDate(now);
  const count = (date: string | null) => listings.filter((l) => checkMoveIn(l, date, now).status === "pass").length;
  const selected = criteria.moveInBy;

  return (
    <div>
      <div className="mb-5 flex flex-wrap gap-2">
        <Chip selected={selected === asap} onClick={() => onChange({ ...criteria, moveInBy: asap })}>
          As soon as possible
        </Chip>
        <Chip selected={selected === null} onClick={() => onChange({ ...criteria, moveInBy: null })}>
          Flexible
        </Chip>
      </div>
      <MoveInCalendar
        value={selected}
        onChange={(iso) => onChange({ ...criteria, moveInBy: iso })}
        today={today(now)}
        availability={availability}
        months={months}
      />
      <p className="tabular mt-4 text-[13px] text-ink-2">
        {selected === null
          ? "Any move-in date. Dots mark days when homes become available."
          : `${homes(count(selected))} available by ${formatDay(selected, now)}. Dots mark days when homes become available.`}
      </p>
    </div>
  );
}

const STAY_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: 3, label: "3 months" },
  { value: 6, label: "6 months" },
  { value: 12, label: "1 year" },
  { value: 24, label: "2 years" },
  { value: null, label: "Flexible" },
];

export function StayPanel({ criteria, onChange, listings, now }: SearchProps) {
  const from = criteria.moveInBy ?? asapDate(now);
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STAY_OPTIONS.map((o) => (
          <Chip
            key={o.label}
            selected={criteria.stayMonths === o.value}
            onClick={() => onChange({ ...criteria, stayMonths: o.value })}
            hint={homes(listings.filter((l) => checkStay(l, o.value).status !== "fail").length)}
          >
            {o.label}
          </Chip>
        ))}
      </div>
      <p className="mt-4 text-[13px] leading-5 text-ink-2">
        {criteria.stayMonths === null
          ? "Any contract length. "
          : `Moving in ${formatDay(from, now)}, staying until about ${formatDay(addMonths(from, criteria.stayMonths), now)}. `}
        Checked against the contract terms in each ad; ads that don&apos;t say are kept and marked to confirm.
      </p>
    </div>
  );
}

export function BudgetPanel({ criteria, onChange, onChangeLive, listings }: SearchProps) {
  const labelId = useId();
  // The thumb and the label follow the pointer instantly; results catch up as a low-priority update.
  const [draft, setDraft] = useState<number | null>(null);
  const committed = criteria.budget ?? BUDGET_MAX;
  const value = draft ?? committed;
  const anyBudget = value >= BUDGET_MAX;

  const totals = useMemo(() => listings.map((l) => monthlyTotal(l.costs).total), [listings]);
  const { counts, step } = useMemo(() => priceHistogram(totals, BUDGET_MIN, BUDGET_MAX, 28), [totals]);
  const peak = Math.max(1, ...counts);
  const within = totals.filter((t) => anyBudget || t <= value).length;
  const toCriteria = (v: number) => ({ ...criteria, budget: v >= BUDGET_MAX ? null : v });

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p id={labelId} className="text-[13px] text-ink-2">
            Monthly total, bills included
          </p>
          <p className="tabular mt-1 text-[28px] leading-none font-semibold tracking-[-0.02em]">
            {anyBudget ? (
              "Any budget"
            ) : (
              <>
                <span className="mr-1.5 text-[17px] font-medium text-ink-2">Up to</span>
                {formatEUR(value)}
              </>
            )}
          </p>
        </div>
        <p className="tabular text-[13px] text-ink-2">
          <NumberFlow value={within} /> {within === 1 ? "home" : "homes"}
        </p>
      </div>

      {/* Honest counts of monthly totals. Colour flips per bar; nothing moves. */}
      <div className="mt-6 flex h-16 items-end gap-[3px]" aria-hidden="true">
        {counts.map((count, i) => (
          <div
            key={i}
            className={cn(
              "flex-1 rounded-t-[3px] transition-colors duration-100",
              anyBudget || BUDGET_MIN + i * step < value ? "bg-ink" : "bg-line",
            )}
            style={{ height: count === 0 ? 2 : `${Math.max(14, (count / peak) * 100)}%` }}
          />
        ))}
      </div>

      <Slider.Root
        value={value}
        min={BUDGET_MIN}
        max={BUDGET_MAX}
        step={BUDGET_STEP}
        thumbAlignment="edge"
        onValueChange={(v) => {
          const next = Array.isArray(v) ? v[0] : v;
          setDraft(next);
          if (onChangeLive) startTransition(() => onChangeLive(toCriteria(next)));
        }}
        onValueCommitted={(v) => {
          const next = Array.isArray(v) ? v[0] : v;
          setDraft(null);
          onChange(toCriteria(next));
        }}
        aria-labelledby={labelId}
      >
        <Slider.Control className="flex h-8 touch-none items-center select-none">
          <Slider.Track className="h-[2px] w-full rounded-full bg-line">
            <Slider.Indicator className="rounded-full bg-ink" />
            <Slider.Thumb
              aria-label="Maximum monthly budget"
              getAriaValueText={(_, v) => (v >= BUDGET_MAX ? "Any budget" : `Up to ${formatEUR(v)}`)}
              className="size-7 rounded-full bg-white shadow-[var(--shadow-pill)] outline-offset-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <div className="tabular mt-1 flex justify-between text-[12px] text-ink-2">
        <span>{formatEUR(BUDGET_MIN)}</span>
        <span>{formatEUR(BUDGET_MAX)}+</span>
      </div>
    </div>
  );
}

const PANELS: Record<Segment, (p: SearchProps) => React.ReactNode> = {
  moveIn: MoveInPanel,
  stay: StayPanel,
  budget: BudgetPanel,
};

const PANEL_TITLES: Record<Segment, string> = {
  moveIn: "When do you want to move in?",
  stay: "How long will you stay?",
  budget: "What can you spend a month?",
};

/* ------------------------------------------------------------------ */
/* Desktop pill                                                         */
/* ------------------------------------------------------------------ */

/** Keeps a wrapper as tall as its content, so a CSS height transition can follow it. */
function useContentHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize[0]?.blockSize ?? el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, height };
}

export function SearchPill(props: SearchProps) {
  const { criteria, now } = props;
  const [active, setActive] = useState<Segment | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { ref: contentRef, height } = useContentHeight();
  const index = active ? SEGMENTS.indexOf(active) : 0;

  useEffect(() => {
    if (!active) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setActive(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [active]);

  const segments: Array<{ key: Segment; label: string; value: string }> = [
    { key: "moveIn", label: "Move in", value: moveInSummary(criteria.moveInBy, now) },
    { key: "stay", label: "Stay", value: staySummary(criteria.stayMonths) },
    { key: "budget", label: "Budget", value: budgetSummary(criteria.budget) },
  ];

  const Panel = PANELS[active ?? "moveIn"];

  return (
    <div ref={rootRef} className="relative [--seg-w:152px] xl:[--seg-w:196px]" data-active={active ? "" : undefined}>
      <div
        role="group"
        aria-label="Your search"
        className={cn(
          "relative flex h-[58px] items-center rounded-full p-1 transition-[background-color,box-shadow] duration-200",
          active ? "bg-line-soft" : "bg-white shadow-[var(--shadow-pill)]",
        )}
      >
        {/* One white highlight slides between segments on the compositor (translate only). */}
        {active && (
          <span
            aria-hidden="true"
            className="absolute top-1 bottom-1 left-1 w-[var(--seg-w)] rounded-full bg-white shadow-[var(--shadow-float)] transition-[translate,opacity] duration-300 ease-[var(--ease-out)] starting:opacity-0"
            style={{ translate: `calc(${index} * var(--seg-w)) 0` }}
          />
        )}
        {segments.map((seg, i) => {
          const isActive = active === seg.key;
          const hideDivider = active !== null && (index === i || index === i - 1);
          return (
            <button
              key={seg.key}
              type="button"
              aria-expanded={isActive}
              aria-controls={panelId}
              onClick={() => setActive((a) => (a === seg.key ? null : seg.key))}
              className={cn(
                "relative h-full w-[var(--seg-w)] shrink-0 rounded-full pr-4 pl-6 text-left outline-offset-[-2px] transition-colors duration-150",
                !isActive && (active ? "hover:bg-line/60" : "hover:bg-hover"),
              )}
            >
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 left-0 h-7 w-px -translate-y-1/2 bg-line transition-opacity duration-150",
                    hideDivider && "opacity-0",
                  )}
                />
              )}
              <span className="relative block text-[12px] leading-4 font-semibold">{seg.label}</span>
              <span className="relative block truncate text-[14px] leading-5 text-ink-2">{seg.value}</span>
            </button>
          );
        })}

        {/* The label is revealed with clip-path (no layout): the pill never changes size. */}
        <button
          type="button"
          onClick={() => {
            setActive(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          aria-label="Show results"
          className="press relative ml-1 size-12 shrink-0"
        >
          <span
            className={cn(
              "absolute inset-y-0 right-0 flex items-center gap-2 rounded-full bg-ink pr-[15px] pl-[18px] whitespace-nowrap text-white",
              "transition-[clip-path] duration-300 ease-[var(--ease-out)]",
              "[clip-path:inset(0_0_0_calc(100%_-_48px)_round_24px)]",
              active && "xl:[clip-path:inset(0_0_0_0_round_24px)]",
            )}
          >
            <span
              className={cn(
                "text-[15px] font-semibold transition-opacity duration-200",
                active ? "opacity-0 xl:opacity-100" : "opacity-0",
              )}
            >
              Search
            </span>
            <MagnifyingGlassIcon size={18} weight="bold" className="shrink-0" />
          </span>
        </button>
      </div>

      {/* Always mounted: opening is a CSS transition, never a mount + measure. */}
      <div
        id={panelId}
        role="dialog"
        aria-label={active ? PANEL_TITLES[active] : undefined}
        inert={!active}
        className={cn(
          "absolute top-full left-1/2 z-10 mt-3 w-[min(720px,calc(100vw-48px))] origin-top -translate-x-1/2 rounded-[32px] bg-white shadow-[var(--shadow-sheet)]",
          "transition-[opacity,scale,visibility] duration-200 ease-[var(--ease-out)]",
          active ? "visible scale-100 opacity-100" : "invisible scale-[0.98] opacity-0",
        )}
      >
        <div
          className="overflow-hidden transition-[height] duration-250 ease-[var(--ease-out)]"
          style={{ height: height ?? undefined }}
        >
          <div ref={contentRef} className="p-7">
            <div key={active ?? "none"} className="hw-swap">
              <h2 className="mb-5 text-[17px] font-semibold tracking-[-0.01em]">
                {PANEL_TITLES[active ?? "moveIn"]}
              </h2>
              <Panel {...props} />
            </div>
          </div>
        </div>
      </div>

      {/* Dim the page while searching, so the panel is the only thing asking for attention. */}
      <div
        aria-hidden="true"
        className={cn(
          "fixed inset-x-0 top-[var(--header-h)] bottom-0 -z-10 bg-black/20 transition-opacity duration-200",
          active ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mobile: compact pill → full-screen sheet                             */
/* ------------------------------------------------------------------ */

export function MobileSearch(props: SearchProps & { resultCount: number }) {
  const { criteria, now, resultCount } = props;
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className="press flex h-12 w-full items-center gap-3 rounded-full bg-white pr-4 pl-4 text-left shadow-[var(--shadow-pill)]"
        aria-label="Edit search"
      >
        <MagnifyingGlassIcon size={18} weight="bold" className="shrink-0" />
        <span className="min-w-0">
          <span className="block text-[14px] leading-4 font-semibold">Homes in Delft</span>
          <span className="block truncate text-[12px] leading-4 text-ink-2">
            {moveInSummary(criteria.moveInBy, now)} · {staySummary(criteria.stayMonths)} ·{" "}
            {budgetSummary(criteria.budget)}
          </span>
        </span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Popup
          className={cn(
            "fixed inset-0 z-50 flex flex-col bg-subtle",
            "transition-[opacity,translate] duration-[350ms] ease-[var(--ease-drawer)]",
            "data-[ending-style]:translate-y-6 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-6 data-[starting-style]:opacity-0",
          )}
        >
          <div className="flex h-16 shrink-0 items-center px-4">
            <Dialog.Close
              aria-label="Close search"
              className="press grid size-9 place-items-center rounded-full bg-white shadow-[var(--shadow-pill)]"
            >
              <XIcon size={16} weight="bold" />
            </Dialog.Close>
            <Dialog.Title className="ml-3 text-[16px] font-semibold">Your search</Dialog.Title>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-28">
            {SEGMENTS.map((key) => {
              const Panel = PANELS[key];
              return (
                <section key={key} className="rounded-[28px] bg-white p-5 shadow-[var(--shadow-pill)]">
                  <h2 className="mb-4 text-[19px] font-semibold tracking-[-0.02em]">{PANEL_TITLES[key]}</h2>
                  <Panel {...props} months={1} />
                </section>
              );
            })}
          </div>
          <div className="fixed inset-x-0 bottom-0 flex items-center justify-between border-t border-line-soft bg-white px-5 py-4">
            <button
              type="button"
              className="text-[15px] font-semibold underline underline-offset-4"
              onClick={() => props.onChange({ moveInBy: null, stayMonths: null, budget: null })}
            >
              Clear all
            </button>
            <Dialog.Close className="press flex h-12 items-center rounded-xl bg-ink px-6 text-[16px] font-semibold text-white">
              <span>
                Show <NumberFlow value={resultCount} className="tabular" /> {resultCount === 1 ? "home" : "homes"}
              </span>
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
