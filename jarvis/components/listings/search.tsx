"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Slider } from "@base-ui/react/slider";
import NumberFlow from "@number-flow/react";
import { CheckIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { startTransition, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatDay, formatEUR, formatMonths } from "@/lib/listings/format";
import { checkMoveIn, checkStay, monthlyTotal } from "@/lib/listings/match";
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

/* ------------------------------------------------------------------ */
/* Summaries                                                            */
/* ------------------------------------------------------------------ */

const today = (now: string) => now.slice(0, 10);

function addDays(iso: string, days: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Next first-of-`month` (0-based) at least two weeks out. Semester anchors for Dutch universities. */
function nextFirstOf(month: number, now: string) {
  const start = new Date(`${addDays(today(now), 14)}T12:00:00Z`);
  const year = start.getUTCMonth() <= month ? start.getUTCFullYear() : start.getUTCFullYear() + 1;
  return new Date(Date.UTC(year, month, 1, 12)).toISOString().slice(0, 10);
}

/** "As soon as possible": the coming two weeks. */
const ASAP = { offset: 7, flex: 7 };
export const asapDate = (now: string) => addDays(today(now), ASAP.offset);

const MOVE_IN_FLEX = [
  { days: 0, label: "Exact date", short: "" },
  { days: 3, label: "± 3 days", short: "± 3 days" },
  { days: 7, label: "± 1 week", short: "± 1 wk" },
  { days: 14, label: "± 2 weeks", short: "± 2 wk" },
  { days: 30, label: "± 1 month", short: "± 1 mo" },
];

const STAY_FLEX = [
  { days: 0, label: "Exact", short: "" },
  { days: 14, label: "± 2 weeks", short: "± 2 wk" },
  { days: 30, label: "± 1 month", short: "± 1 mo" },
  { days: 60, label: "± 2 months", short: "± 2 mo" },
];

const flexShort = (table: typeof MOVE_IN_FLEX, days: number) =>
  table.find((f) => f.days === days)?.short ?? `± ${days} days`;

export function moveInSummary(c: SearchCriteria, now: string) {
  if (c.moveIn === null) return "Any date";
  if (c.moveIn === asapDate(now) && c.moveInFlexDays === ASAP.flex) return "As soon as possible";
  const flex = flexShort(MOVE_IN_FLEX, c.moveInFlexDays);
  return `${formatDay(c.moveIn, now)}${flex ? ` ${flex}` : ""}`;
}

export function staySummary(c: SearchCriteria) {
  if (c.stayMonths === null) return "No end date";
  const flex = flexShort(STAY_FLEX, c.stayFlexDays);
  return `${formatMonths(c.stayMonths)}${flex ? ` ${flex}` : ""}`;
}

/** "1 Feb ± 1 mo · no end date" or "1 Feb to ~1 Jan 2028". */
export function availabilitySummary(c: SearchCriteria, now: string) {
  if (c.moveIn === null && c.stayMonths === null) return "Any time";
  const start = moveInSummary(c, now);
  if (c.stayMonths === null) return `${start} · no end`;
  const from = c.moveIn ?? asapDate(now);
  return `${start} → ${formatDay(addMonths(from, c.stayMonths), now)}`;
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

/** Small segmented row for tolerances: one tap, no dropdown. */
function FlexRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: Array<{ days: number; label: string }>;
  onChange: (days: number) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.days}
            type="button"
            role="radio"
            aria-checked={value === o.days}
            onClick={() => onChange(o.days)}
            className={cn(
              "press h-9 rounded-full px-3.5 text-[13px] transition-colors duration-150",
              value === o.days
                ? "bg-ink font-semibold text-white"
                : "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--color-ink)]",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MoveInPanel({
  criteria,
  onChange,
  listings,
  now,
  months = 2,
  onPickDate,
}: SearchProps & { onPickDate?: () => void }) {
  const availability = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of listings) map[l.tenancy.availableFrom] = (map[l.tenancy.availableFrom] ?? 0) + 1;
    return map;
  }, [listings]);

  const asap = asapDate(now);
  const semester2 = nextFirstOf(1, now);
  const academicYear = nextFirstOf(8, now);
  const presets = [
    { label: "As soon as possible", hint: "Next two weeks", moveIn: asap, flex: ASAP.flex },
    { label: "Semester start", hint: formatDay(semester2, now), moveIn: semester2, flex: 30 },
    { label: "Academic year", hint: formatDay(academicYear, now), moveIn: academicYear, flex: 30 },
  ];

  const statuses = listings.map((l) => checkMoveIn(l, criteria, now).status);
  const inWindow = statuses.filter((s) => s === "pass").length;
  const earlier = statuses.filter((s) => s === "unknown").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <Chip
            key={p.label}
            hint={p.hint}
            selected={criteria.moveIn === p.moveIn && criteria.moveInFlexDays === p.flex}
            onClick={() => onChange({ ...criteria, moveIn: p.moveIn, moveInFlexDays: p.flex })}
          >
            {p.label}
          </Chip>
        ))}
        <Chip
          hint="Show everything"
          selected={criteria.moveIn === null}
          onClick={() => onChange({ ...criteria, moveIn: null })}
        >
          Any date
        </Chip>
      </div>

      <MoveInCalendar
        value={criteria.moveIn}
        onChange={(iso) => {
          onChange({ ...criteria, moveIn: iso });
          onPickDate?.();
        }}
        today={today(now)}
        availability={availability}
        months={months}
        flexDays={criteria.moveInFlexDays}
        maxDate={addMonths(today(now), 12)}
      />

      <FlexRow
        label="How flexible is your move-in?"
        value={criteria.moveInFlexDays}
        options={MOVE_IN_FLEX}
        onChange={(days) => onChange({ ...criteria, moveInFlexDays: days, moveIn: criteria.moveIn ?? asap })}
      />

      <p className="tabular text-[13px] leading-5 text-ink-2">
        {criteria.moveIn === null
          ? "Any move-in date. Dots mark days when homes become available."
          : `${homes(inWindow)} free in your window${
              earlier ? `, ${earlier} more earlier (you'd ask to start later, or pay the gap)` : ""
            }. Dots mark days when homes become available.`}
      </p>
    </div>
  );
}

/** Student-shaped presets: people know "a semester" or "my MSc" before they know a date. */
const STAY_PRESETS: Array<{ value: number | null; label: string; hint: string }> = [
  { value: null, label: "No end date", hint: "Open-ended" },
  { value: 5, label: "One semester", hint: "~5 mo" },
  { value: 11, label: "Academic year", hint: "~11 mo" },
  { value: 24, label: "Two years", hint: "MSc" },
  { value: 48, label: "Four years", hint: "PhD" },
];

export function StayPanel({ criteria, onChange, listings, now }: SearchProps) {
  const from = criteria.moveIn ?? asapDate(now);
  const months = criteria.stayMonths;
  const fits = (value: number | null) =>
    listings.filter((l) => checkStay(l, { stayMonths: value, stayFlexDays: criteria.stayFlexDays }).status !== "fail")
      .length;
  const step = (delta: number) =>
    onChange({ ...criteria, stayMonths: Math.min(60, Math.max(1, (months ?? 6) + delta)) });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STAY_PRESETS.map((o) => (
          <Chip
            key={o.label}
            selected={months === o.value}
            onClick={() => onChange({ ...criteria, stayMonths: o.value })}
            hint={`${o.hint} · ${homes(fits(o.value))}`}
          >
            {o.label}
          </Chip>
        ))}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-2xl bg-subtle px-4 py-3">
        <p className="text-[14px] font-medium">Or exactly</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="One month less"
            onClick={() => step(-1)}
            disabled={months !== null && months <= 1}
            className="press grid size-8 place-items-center rounded-full bg-white shadow-[inset_0_0_0_1px_var(--color-line)] disabled:opacity-40"
          >
            −
          </button>
          <span className="tabular w-24 text-center text-[15px] font-semibold" aria-live="polite">
            {months === null ? "—" : formatMonths(months)}
          </span>
          <button
            type="button"
            aria-label="One month more"
            onClick={() => step(1)}
            className="press grid size-8 place-items-center rounded-full bg-white shadow-[inset_0_0_0_1px_var(--color-line)]"
          >
            +
          </button>
        </div>
      </div>

      {months !== null && (
        <FlexRow
          label="The contract may end earlier or later by"
          value={criteria.stayFlexDays}
          options={STAY_FLEX}
          onChange={(days) => onChange({ ...criteria, stayFlexDays: days })}
        />
      )}

      {months !== null && (
        <div className="rounded-2xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--color-line-soft)]" aria-label="Your stay">
          <div className="tabular flex items-center justify-between text-[13px]">
            <span>
              <span className="block font-semibold">{formatDay(from, now)}</span>
              <span className="text-ink-2">
                Move in{criteria.moveIn && criteria.moveInFlexDays ? ` ${flexShort(MOVE_IN_FLEX, criteria.moveInFlexDays)}` : ""}
              </span>
            </span>
            <span aria-hidden="true" className="mx-4 h-px flex-1 bg-ink" />
            <span className="text-right">
              <span className="block font-semibold">{formatDay(addMonths(from, months), now)}</span>
              <span className="text-ink-2">
                Move out{criteria.stayFlexDays ? ` ${flexShort(STAY_FLEX, criteria.stayFlexDays)}` : ""}
              </span>
            </span>
          </div>
        </div>
      )}

      <p className="text-[13px] leading-5 text-ink-2">
        {months === null
          ? "Open-ended contracts fit. Fixed-term contracts are kept but marked to confirm, since you'd have to move again."
          : "Fixed terms that end a little early, or minimum stays a little longer, count as “to confirm” within your tolerance. Open-ended contracts always fit; you give notice when you leave."}
      </p>
    </div>
  );
}

export function UniversityPanel({ criteria, onChange }: SearchProps) {
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
                  onClick={() => onChange({ ...criteria, university: u.id })}
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

/** Move in and move out in one place, like check-in/check-out. Picking a date moves you on. */
export function AvailabilityPanel(props: SearchProps & { stacked?: boolean }) {
  const { criteria, now, stacked } = props;
  const [tab, setTab] = useState<"in" | "out">("in");
  if (stacked) {
    return (
      <div className="space-y-8">
        <MoveInPanel {...props} />
        <div>
          <h3 className="mb-4 text-[17px] font-semibold tracking-[-0.01em]">When will you move out?</h3>
          <StayPanel {...props} />
        </div>
      </div>
    );
  }
  const tabs = [
    { key: "in" as const, label: "Move in", value: moveInSummary(criteria, now) },
    { key: "out" as const, label: "Move out", value: staySummary(criteria) },
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
            <span className="block truncate text-[14px] text-ink-2">{t.value}</span>
          </button>
        ))}
      </div>
      <div key={tab} className="hw-swap" role="tabpanel">
        {tab === "in" ? (
          <MoveInPanel
            {...props}
            onPickDate={() => setTab("out")}
          />
        ) : (
          <StayPanel {...props} />
        )}
      </div>
    </div>
  );
}

const BUDGET_PRESETS = [600, 800, 1000, 1250];

export function BudgetPanel({ criteria, onChange, onChangeLive, listings }: SearchProps) {
  const labelId = useId();
  // The thumb and the label follow the pointer instantly; results catch up as a low-priority update.
  const [draft, setDraft] = useState<number | null>(null);
  const committed = criteria.budget ?? BUDGET_MAX;
  const value = draft ?? committed;
  const anyBudget = value >= BUDGET_MAX;
  const dragging = draft !== null;
  const pct = ((value - BUDGET_MIN) / (BUDGET_MAX - BUDGET_MIN)) * 100;

  const totals = useMemo(() => listings.map((l) => monthlyTotal(l.costs).total), [listings]);
  const { counts, step } = useMemo(() => priceHistogram(totals, BUDGET_MIN, BUDGET_MAX, 30), [totals]);
  const typical = useMemo(() => Math.round(median(totals) / 10) * 10, [totals]);
  const peak = Math.max(1, ...counts);
  const within = totals.filter((t) => anyBudget || t <= value).length;
  const toCriteria = (v: number) => ({ ...criteria, budget: v >= BUDGET_MAX ? null : v });
  const typicalPct = ((typical - BUDGET_MIN) / (BUDGET_MAX - BUDGET_MIN)) * 100;

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p id={labelId} className="text-[13px] text-ink-2">
            Monthly total, bills included
          </p>
          <p className="tabular mt-1 text-[30px] leading-none font-semibold tracking-[-0.02em]">
            {anyBudget ? "Any budget" : formatEUR(value)}
          </p>
        </div>
        <p className="tabular text-right text-[13px] text-ink-2">
          <span className="block text-[20px] font-semibold text-ink">
            <NumberFlow value={within} />
          </span>
          {within === 1 ? "home fits" : "homes fit"}
        </p>
      </div>

      {/* Histogram: in-range bars are ink; bars near the thumb lift a little as you drag. */}
      <div className="relative mt-7 h-20" aria-hidden="true">
        <div className="absolute inset-0 flex items-end gap-[3px]">
          {counts.map((count, i) => {
            const centre = BUDGET_MIN + (i + 0.5) * step;
            const inRange = anyBudget || centre <= value;
            const near = dragging && Math.abs(centre - value) < step * 1.5;
            return (
              <div
                key={i}
                className={cn(
                  "hw-bar flex-1 origin-bottom rounded-t-[3px]",
                  inRange ? "bg-ink" : "bg-line",
                  near && "scale-y-[1.12]",
                )}
                style={{ height: count === 0 ? 3 : `${Math.max(12, (count / peak) * 100)}%` }}
              />
            );
          })}
        </div>
        {typical > BUDGET_MIN && (
          <div className="absolute inset-y-0 border-l border-dashed border-ink-3" style={{ left: `${typicalPct}%` }}>
            <span className="tabular absolute -top-5 -translate-x-1/2 text-[11px] whitespace-nowrap text-ink-2">
              typical {formatEUR(typical)}
            </span>
          </div>
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
              {/* Value bubble rides on the thumb while dragging. */}
              <span
                aria-hidden="true"
                className={cn(
                  "tabular pointer-events-none absolute bottom-full mb-2.5 rounded-lg bg-ink px-2 py-1 text-[12px] font-semibold whitespace-nowrap text-white",
                  "origin-bottom transition-[opacity,scale] duration-150 ease-[var(--ease-out)]",
                  dragging ? "scale-100 opacity-100" : "scale-90 opacity-0",
                )}
              >
                {anyBudget ? "Any" : formatEUR(value)}
              </span>
            </Slider.Thumb>
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <div className="tabular mt-0.5 flex justify-between text-[12px] text-ink-2" style={{ "--pct": pct } as React.CSSProperties}>
        <span>{formatEUR(BUDGET_MIN)}</span>
        <span>{formatEUR(BUDGET_MAX)}+</span>
      </div>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {BUDGET_PRESETS.map((b) => (
          <button
            key={b}
            type="button"
            aria-pressed={criteria.budget === b}
            onClick={() => onChange({ ...criteria, budget: b })}
            className={cn(
              "press tabular h-8 rounded-full px-3 text-[13px] transition-colors duration-150",
              criteria.budget === b
                ? "bg-ink font-semibold text-white"
                : "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--color-ink)]",
            )}
          >
            {formatEUR(b)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={criteria.budget === null}
          onClick={() => onChange({ ...criteria, budget: null })}
          className={cn(
            "press h-8 rounded-full px-3 text-[13px] transition-colors duration-150",
            criteria.budget === null
              ? "bg-ink font-semibold text-white"
              : "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--color-ink)]",
          )}
        >
          Any
        </button>
      </div>
    </div>
  );
}

const PANELS: Record<Segment, (p: SearchProps & { stacked?: boolean }) => React.ReactNode> = {
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
              onClick={() => {
                setEverOpened(true);
                setActive((a) => (a === seg.key ? null : seg.key));
              }}
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
            {everOpened && (
              <div key={active ?? "none"} className="hw-swap">
                <h2 className="mb-5 text-[17px] font-semibold tracking-[-0.01em]">
                  {PANEL_TITLES[active ?? "university"]}
                </h2>
                <Panel {...props} />
              </div>
            )}
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
                  moveInFlexDays: 7,
                  stayMonths: null,
                  stayFlexDays: 30,
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
