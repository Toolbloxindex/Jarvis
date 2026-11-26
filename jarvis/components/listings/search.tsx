"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Slider } from "@base-ui/react/slider";
import NumberFlow from "@number-flow/react";
import { CheckIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { startTransition, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatDay, formatEUR } from "@/lib/listings/format";
import { monthlyTotal } from "@/lib/listings/match";
import { priceHistogram } from "@/lib/listings/query";
import { median } from "@/lib/listings/scores";
import { UNIVERSITIES, universityById } from "@/lib/universities";
import type { Listing, SearchCriteria } from "@/lib/listings/types";
import { MoveInCalendar } from "./move-in-calendar";

type Segment = "university" | "availability" | "budget";
const SEGMENTS: Segment[] = ["university", "availability", "budget"];

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

interface PanelProps extends SearchProps {
  /** Mobile sheet: every section visible, no tabs, no auto-advance. */
  stacked?: boolean;
  /** A final choice was made in this panel: move on to the next one. */
  onAdvance?: () => void;
}

/* ------------------------------------------------------------------ */
/* Summaries                                                            */
/* ------------------------------------------------------------------ */

const today = (now: string) => now.slice(0, 10);

function addMonths(iso: string, months: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

interface Flex {
  days: number;
  /** Chip text. */
  chip: string;
  /** Suffix in summaries; empty for an exact date. */
  short: string;
}

const MOVE_IN_FLEX: Flex[] = [
  { days: 0, chip: "Exact", short: "" },
  { days: 3, chip: "±3 d", short: "± 3 d" },
  { days: 7, chip: "±1 wk", short: "± 1 wk" },
  { days: 14, chip: "±2 wk", short: "± 2 wk" },
  { days: 30, chip: "±1 mo", short: "± 1 mo" },
];

const MOVE_OUT_FLEX: Flex[] = [
  { days: 0, chip: "Exact", short: "" },
  { days: 7, chip: "±1 wk", short: "± 1 wk" },
  { days: 14, chip: "±2 wk", short: "± 2 wk" },
  { days: 30, chip: "±1 mo", short: "± 1 mo" },
  { days: 60, chip: "±2 mo", short: "± 2 mo" },
];

const withFlex = (date: string, table: Flex[], days: number) => {
  const flex = table.find((f) => f.days === days)?.short ?? (days ? `± ${days} d` : "");
  return flex ? `${date} ${flex}` : date;
};

const fullDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "1 Feb ± 1 mo" or "Any date". */
export function moveInSummary(c: SearchCriteria, now: string) {
  return c.moveIn === null ? "Any date" : withFlex(formatDay(c.moveIn, now), MOVE_IN_FLEX, c.moveInFlexDays);
}

/** "1 Jul 2027 ± 2 wk" or "Indefinite". Move-outs can be years away, so the year is always shown. */
export function moveOutSummary(c: SearchCriteria) {
  if (c.moveOut === null) return "Indefinite";
  return withFlex(fullDay.format(new Date(`${c.moveOut}T12:00:00Z`)), MOVE_OUT_FLEX, c.moveOutFlexDays);
}

/** "1 Feb ± 1 mo → Indefinite" or "1 Feb → 1 Jul 2027 ± 2 wk". */
export function availabilitySummary(c: SearchCriteria, now: string) {
  if (c.moveIn === null && c.moveOut === null) return "Any time";
  return `${moveInSummary(c, now)} → ${moveOutSummary(c)}`;
}

export function budgetSummary(budget: number | null) {
  return budget === null ? "Any budget" : `Up to ${formatEUR(budget)}`;
}

/* ------------------------------------------------------------------ */
/* Panels (shared by the desktop pill and the mobile sheet)             */
/* ------------------------------------------------------------------ */

const outlined =
  "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] [@media(hover:hover)]:hover:text-ink [@media(hover:hover)]:hover:shadow-[inset_0_0_0_1px_var(--color-ink)]";

/** One compact row of tolerances. Same weight selected or not, so nothing reflows. */
function Tolerance({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  options: Flex[];
  onChange: (days: number) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn("flex flex-wrap gap-1 transition-opacity duration-150 sm:gap-1.5", disabled && "opacity-40")}
    >
      {options.map((o) => {
        const selected = value === o.days;
        return (
          <button
            key={o.days}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(o.days)}
            className={cn(
              "press tabular h-8 rounded-full px-2.5 text-[13px] font-medium whitespace-nowrap sm:px-3 transition-[color,background-color,box-shadow] duration-150",
              selected ? "bg-ink text-white" : outlined,
              disabled && "pointer-events-none",
            )}
          >
            {o.chip}
          </button>
        );
      })}
    </div>
  );
}

function MoveInSection({ criteria, onChange, listings, now, months = 2, onPick }: PanelProps & { onPick?: () => void }) {
  const availability = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of listings) map[l.tenancy.availableFrom] = (map[l.tenancy.availableFrom] ?? 0) + 1;
    return map;
  }, [listings]);

  return (
    <div>
      <MoveInCalendar
        value={criteria.moveIn}
        onChange={(iso) => {
          // A move-out before the new move-in no longer makes sense: fall back to indefinite.
          const moveOut = criteria.moveOut !== null && criteria.moveOut <= iso ? null : criteria.moveOut;
          onChange({ ...criteria, moveIn: iso, moveOut });
          onPick?.();
        }}
        today={today(now)}
        availability={availability}
        months={months}
        flexDays={criteria.moveInFlexDays}
        maxDate={addMonths(today(now), 12)}
      />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Tolerance
          label="Move-in flexibility"
          value={criteria.moveInFlexDays}
          options={MOVE_IN_FLEX}
          disabled={criteria.moveIn === null}
          onChange={(days) => onChange({ ...criteria, moveInFlexDays: days })}
        />
        <button
          type="button"
          disabled={criteria.moveIn === null}
          onClick={() => onChange({ ...criteria, moveIn: null })}
          className="h-8 px-1 text-[13px] font-semibold underline underline-offset-4 disabled:text-ink-3 disabled:no-underline"
        >
          Any date
        </button>
      </div>
    </div>
  );
}

function MoveOutSection({ criteria, onChange, now, months = 2, onPick }: PanelProps & { onPick?: () => void }) {
  const indefinite = criteria.moveOut === null;
  return (
    <div>
      <MoveInCalendar
        value={criteria.moveOut}
        onChange={(iso) => {
          onChange({ ...criteria, moveOut: iso });
          onPick?.();
        }}
        today={today(now)}
        minDate={criteria.moveIn ?? today(now)}
        maxDate={addMonths(today(now), 60)}
        months={months}
        flexDays={criteria.moveOutFlexDays}
      />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Tolerance
          label="Move-out flexibility"
          value={criteria.moveOutFlexDays}
          options={MOVE_OUT_FLEX}
          disabled={indefinite}
          onChange={(days) => onChange({ ...criteria, moveOutFlexDays: days })}
        />
        <button
          type="button"
          aria-pressed={indefinite}
          onClick={() => {
            if (!indefinite) onChange({ ...criteria, moveOut: null });
            onPick?.();
          }}
          className={cn(
            "press h-8 rounded-full px-3.5 text-[13px] font-medium transition-[color,background-color,box-shadow] duration-150",
            indefinite ? "bg-ink text-white" : outlined,
          )}
        >
          Indefinite
        </button>
      </div>
    </div>
  );
}

export function UniversityPanel({ criteria, onChange, onAdvance }: PanelProps) {
  const cities = [...new Set(UNIVERSITIES.map((u) => u.city))];
  return (
    <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
      {cities.map((city) => (
        <div key={city}>
          <p className="mb-1.5 text-[12px] font-semibold tracking-[0.02em] text-ink-2">{city}</p>
          <div role="radiogroup" aria-label={`Universities in ${city}`} className="space-y-1">
            {UNIVERSITIES.filter((u) => u.city === city).map((u) => {
              const selected = criteria.university === u.id;
              return (
                <button
                  key={u.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    if (!selected) onChange({ ...criteria, university: u.id });
                    onAdvance?.();
                  }}
                  className={cn(
                    "press flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150",
                    selected ? "bg-subtle" : "hover:bg-hover",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold">{u.name}</span>
                    <span className="block truncate text-[12px] text-ink-2">Times to {u.place}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-150",
                      selected ? "bg-ink text-white" : "shadow-[inset_0_0_0_1.5px_var(--color-line)]",
                    )}
                  >
                    {selected && <CheckIcon size={11} weight="bold" />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Move in and move out, like check-in/check-out. Picking a date moves you on. */
export function AvailabilityPanel(props: PanelProps) {
  const { criteria, now, stacked, onAdvance } = props;
  const [tab, setTab] = useState<"in" | "out">("in");
  if (stacked) {
    return (
      <div className="space-y-8">
        {(["in", "out"] as const).map((key) => (
          <section key={key} aria-label={key === "in" ? "Move in" : "Move out"}>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="text-[15px] font-semibold">{key === "in" ? "Move in" : "Move out"}</h3>
              <span className="tabular truncate text-[13px] text-ink-2">
                {key === "in" ? moveInSummary(criteria, now) : moveOutSummary(criteria)}
              </span>
            </div>
            {key === "in" ? <MoveInSection {...props} /> : <MoveOutSection {...props} />}
          </section>
        ))}
      </div>
    );
  }
  const tabs = [
    { key: "in" as const, label: "Move in", value: moveInSummary(criteria, now) },
    { key: "out" as const, label: "Move out", value: moveOutSummary(criteria) },
  ];
  return (
    <div>
      <div role="tablist" aria-label="Availability" className="mb-6 grid grid-cols-2 rounded-2xl bg-subtle p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "press rounded-xl px-4 py-2.5 text-left transition-[background-color,box-shadow] duration-150",
              tab === t.key ? "bg-white shadow-[var(--shadow-pill)]" : "hover:bg-hover",
            )}
          >
            <span className="block text-[12px] font-semibold">{t.label}</span>
            <span className="tabular block truncate text-[14px] text-ink-2">{t.value}</span>
          </button>
        ))}
      </div>
      <div key={tab} className="hw-swap" role="tabpanel">
        {tab === "in" ? (
          <MoveInSection {...props} onPick={() => setTab("out")} />
        ) : (
          <MoveOutSection {...props} onPick={onAdvance} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Budget                                                               */
/* ------------------------------------------------------------------ */

/**
 * Bars are a fixed-height grey column with an ink layer on top, so "in range" is an opacity
 * change (compositor only), rippling out from the thumb via --d. Bars top out at 90% of the
 * box so the lift near the thumb (scale 1.08) always stays inside it.
 */
const BUDGET_CSS = `
.hw-hist { contain: layout paint; }
.hw-hbar {
  position: relative;
  flex: 1 1 0;
  border-radius: 3px 3px 0 0;
  background: var(--color-line);
  transform-origin: 50% 100%;
  transition: scale 260ms var(--ease-out);
}
.hw-hbar::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--color-ink);
  opacity: 0;
  transition: opacity 200ms var(--ease-out) var(--d, 0ms);
}
.hw-hbar[data-in]::after { opacity: 1; }
.hw-hbar[data-near] { scale: 1 1.08; }
.hw-bubble {
  transform-origin: 50% 100%;
  opacity: 0;
  scale: 0.7;
  translate: 0 6px;
  transition:
    opacity 120ms ease,
    scale 200ms var(--ease-out),
    translate 200ms var(--ease-out);
}
.hw-bubble[data-show] {
  opacity: 1;
  scale: 1;
  translate: 0 0;
  transition:
    opacity 120ms ease,
    scale 420ms linear(0, 0.16 4%, 0.46 10%, 0.8 18%, 0.98 26%, 1.04 34%, 1.05 40%, 1.03 50%, 1.006 62%, 0.998 75%, 1),
    translate 420ms linear(0, 0.16 4%, 0.46 10%, 0.8 18%, 0.98 26%, 1.04 34%, 1.05 40%, 1.03 50%, 1.006 62%, 0.998 75%, 1);
}
@media (prefers-reduced-motion: reduce) {
  .hw-hbar, .hw-hbar::after, .hw-bubble, .hw-bubble[data-show] { transition-duration: 0ms; transition-delay: 0ms; }
  .hw-hbar[data-near] { scale: none; }
}
`;

/** Stagger per bucket away from the thumb, capped so a jump settles within ~120 ms. */
const RIPPLE_MS = 12;
const RIPPLE_MAX = 10;

export function BudgetPanel({ criteria, onChange, onChangeLive, listings }: PanelProps) {
  const labelId = useId();
  // The thumb and the label follow the pointer instantly; results catch up as a low-priority update.
  const [draft, setDraft] = useState<number | null>(null);
  const committed = criteria.budget ?? BUDGET_MAX;
  const value = draft ?? committed;
  const anyBudget = value >= BUDGET_MAX;
  const dragging = draft !== null;

  const totals = useMemo(() => listings.map((l) => monthlyTotal(l.costs).total), [listings]);
  const { counts, step } = useMemo(() => priceHistogram(totals, BUDGET_MIN, BUDGET_MAX, 30), [totals]);
  const typical = useMemo(() => Math.round(median(totals) / 10) * 10, [totals]);
  const peak = Math.max(1, ...counts);
  const within = totals.filter((t) => anyBudget || t <= value).length;
  const toCriteria = (v: number) => ({ ...criteria, budget: v >= BUDGET_MAX ? null : v });
  const typicalPct = ((typical - BUDGET_MIN) / (BUDGET_MAX - BUDGET_MIN)) * 100;
  const thumbBucket = (value - BUDGET_MIN) / step - 0.5;

  return (
    <div>
      <style href="hw-budget" precedence="medium">
        {BUDGET_CSS}
      </style>

      {/* Fixed-height row: the value and the count never change the panel's size. */}
      <div className="flex h-[58px] items-end justify-between gap-4">
        <div className="min-w-0">
          <p id={labelId} className="text-[13px] leading-5 text-ink-2">
            Monthly total, bills included
          </p>
          <p
            data-budget-value=""
            className="tabular mt-2 h-[30px] text-[30px] leading-[30px] font-semibold tracking-[-0.02em] whitespace-nowrap"
          >
            {anyBudget ? "Any budget" : formatEUR(value)}
          </p>
        </div>
        <div data-budget-count="" className="tabular w-24 shrink-0 text-right">
          <span className="block h-7 text-[20px] leading-7 font-semibold">
            <NumberFlow value={within} />
          </span>
          <span className="block text-[13px] leading-5 text-ink-2">{within === 1 ? "home fits" : "homes fit"}</span>
        </div>
      </div>

      {/* Histogram: a fixed 100px box (20px label row + 80px bars). Only scale/opacity move inside it. */}
      <div data-histogram="" className="hw-hist relative mt-6 h-[100px]" aria-hidden="true">
        {typical > BUDGET_MIN && (
          <span
            className="tabular absolute top-0 h-5 -translate-x-1/2 text-[11px] leading-4 whitespace-nowrap text-ink-2"
            style={{ left: `clamp(48px, ${typicalPct}%, calc(100% - 48px))` }}
          >
            typical {formatEUR(typical)}
          </span>
        )}
        <div className="absolute inset-x-0 bottom-0 flex h-20 items-end gap-[3px]">
          {counts.map((count, i) => {
            const centre = BUDGET_MIN + (i + 0.5) * step;
            const distance = Math.abs(i - thumbBucket);
            return (
              <div
                key={i}
                data-bar=""
                data-in={anyBudget || centre <= value ? "" : undefined}
                data-near={dragging && distance < 1.5 ? "" : undefined}
                className="hw-hbar"
                style={
                  {
                    height: count === 0 ? 3 : `${Math.max(12, (count / peak) * 90)}%`,
                    "--d": `${Math.round(Math.min(distance, RIPPLE_MAX) * RIPPLE_MS)}ms`,
                  } as React.CSSProperties
                }
              />
            );
          })}
        </div>
        {typical > BUDGET_MIN && (
          <div
            className="absolute bottom-0 h-20 border-l border-dashed border-ink-3"
            style={{ left: `${typicalPct}%` }}
          />
        )}
      </div>

      <Slider.Root
        value={value}
        min={BUDGET_MIN}
        max={BUDGET_MAX}
        step={BUDGET_STEP}
        largeStep={100}
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
        <Slider.Control className="group/slider flex h-10 cursor-pointer touch-none items-center select-none">
          <Slider.Track className="h-1 w-full rounded-full bg-line">
            <Slider.Indicator className="rounded-full bg-ink" />
            <Slider.Thumb
              aria-label="Maximum monthly budget"
              getAriaValueText={(_, v) => (v >= BUDGET_MAX ? "Any budget" : `Up to ${formatEUR(v)}`)}
              className={cn(
                "hw-thumb relative grid size-8 cursor-grab place-items-center rounded-full bg-white outline-offset-4 active:cursor-grabbing",
                "shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_2px_8px_rgb(0_0_0/0.18)]",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink",
              )}
            >
              <span aria-hidden="true" className="flex gap-[3px]">
                <span className="h-2.5 w-px bg-ink-3" />
                <span className="h-2.5 w-px bg-ink-3" />
              </span>
              {/* Value bubble rides on the thumb while dragging and springs in. */}
              <span
                aria-hidden="true"
                data-show={dragging ? "" : undefined}
                className="hw-bubble tabular pointer-events-none absolute bottom-full mb-2.5 min-w-[52px] rounded-lg bg-ink px-2 py-1 text-center text-[12px] font-semibold whitespace-nowrap text-white"
              >
                {anyBudget ? "Any" : formatEUR(value)}
              </span>
            </Slider.Thumb>
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <div className="tabular mt-0.5 flex justify-between text-[12px] text-ink-2">
        <span>{formatEUR(BUDGET_MIN)}</span>
        <span>{formatEUR(BUDGET_MAX)}+</span>
      </div>
    </div>
  );
}

const PANELS: Record<Segment, (p: PanelProps) => React.ReactNode> = {
  university: UniversityPanel,
  availability: AvailabilityPanel,
  budget: BudgetPanel,
};

const PANEL_TITLES: Record<Segment, string> = {
  university: "Where do you study?",
  availability: "When do you need it?",
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
  // Panel content (two calendar months, histogram) renders on first open, not during hydration.
  const [everOpened, setEverOpened] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { ref: contentRef, height } = useContentHeight();
  const index = active ? SEGMENTS.indexOf(active) : 0;
  // When the panel last opened: the press that opened it must never also close it.
  const openedAt = useRef(0);

  const open = (seg: Segment, at: number) => {
    setEverOpened(true);
    if (active === null) openedAt.current = at;
    // The active segment stays open on a repeat press (double-clicks used to open then close it).
    setActive(seg);
  };
  const advance = () => setActive((a) => (a ? SEGMENTS[Math.min(SEGMENTS.indexOf(a) + 1, SEGMENTS.length - 1)] : a));

  useEffect(() => {
    if (!active) return;
    const onPointer = (e: PointerEvent) => {
      if (e.timeStamp - openedAt.current < 250) return;
      // The dim layer lives inside the root but counts as outside.
      const target = e.target as HTMLElement;
      if (!rootRef.current?.contains(target) || target.hasAttribute("data-search-dim")) setActive(null);
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
    { key: "university", label: "University", value: universityById(criteria.university).short },
    { key: "availability", label: "Availability", value: availabilitySummary(criteria, now) },
    { key: "budget", label: "Budget", value: budgetSummary(criteria.budget) },
  ];

  const Panel = PANELS[active ?? "university"];

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
              onClick={(e) => open(seg.key, e.timeStamp)}
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
              <span className="relative block truncate text-[14px] leading-5 text-ink-2" title={seg.value}>
                {seg.value}
              </span>
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
            {everOpened && (
              <div key={active ?? "none"} className="hw-swap">
                <h2 className="mb-5 text-[17px] font-semibold tracking-[-0.01em]">
                  {PANEL_TITLES[active ?? "university"]}
                </h2>
                <Panel {...props} onAdvance={advance} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dim the page while searching, so the panel is the only thing asking for attention. */}
      <div
        aria-hidden="true"
        data-search-dim=""
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
  const openedAt = useRef(0);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        // The tap that opened the sheet can land as an outside press on the fresh popup: ignore it.
        const at = details.event.timeStamp;
        if (!next && details.reason === "outside-press" && at - openedAt.current < 300) {
          details.cancel();
          return;
        }
        if (next) openedAt.current = at;
        setOpen(next);
      }}
    >
      <Dialog.Trigger
        className="press flex h-12 w-full items-center gap-3 rounded-full bg-white pr-4 pl-4 text-left shadow-[var(--shadow-pill)]"
        aria-label="Edit search"
      >
        <MagnifyingGlassIcon size={18} weight="bold" className="shrink-0" />
        <span className="min-w-0">
          <span className="block truncate text-[14px] leading-4 font-semibold">
            Near {universityById(criteria.university).short}
          </span>
          <span className="block truncate text-[12px] leading-4 text-ink-2">
            {availabilitySummary(criteria, now)} · {budgetSummary(criteria.budget)}
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
                  <Panel {...props} months={1} stacked />
                </section>
              );
            })}
          </div>
          <div className="fixed inset-x-0 bottom-0 flex items-center justify-between border-t border-line-soft bg-white px-5 py-4">
            <button
              type="button"
              className="text-[15px] font-semibold underline underline-offset-4"
              onClick={() =>
                props.onChange({
                  university: criteria.university,
                  moveIn: null,
                  moveInFlexDays: 30,
                  moveOut: null,
                  moveOutFlexDays: 14,
                  budget: null,
                })
              }
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
