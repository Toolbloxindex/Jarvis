"use client";

import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export interface MoveInCalendarProps {
  /** Selected move-in date, YYYY-MM-DD, or null. */
  value: string | null;
  onChange: (isoDate: string) => void;
  /** "Today", YYYY-MM-DD. Never call new Date() for "today" — use this prop (deterministic SSR). */
  today: string;
  /** First selectable day (YYYY-MM-DD); days before it are disabled. Default: `today`. */
  minDate?: string;
  /** YYYY-MM-DD → number of homes that become available on that day. Omit for no dots. */
  availability?: Record<string, number>;
  /** Months shown side by side: 2 on desktop panels, 1 on mobile. Default 2. */
  months?: 1 | 2;
  /** Last selectable day (YYYY-MM-DD). Default: today + 9 months. */
  maxDate?: string;
  /**
   * ± days of flexibility around `value`. The band shows that window (clamped to `minDate`).
   * Omit to show the "available by" band from today up to `value`.
   */
  flexDays?: number;
  className?: string;
}

/* ------------------------------------------------------------------ */
/* Date math: whole days since the epoch, all in UTC.                    */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD → day number (parsed as UTC noon, so no DST/timezone drift). */
function toDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 12) / DAY_MS);
}

function toIso(day: number): string {
  return new Date(day * DAY_MS + DAY_MS / 2).toISOString().slice(0, 10);
}

function dateOf(day: number) {
  const d = new Date(day * DAY_MS + DAY_MS / 2);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

/** Monday = 0 … Sunday = 6. */
function weekdayOf(day: number): number {
  return (new Date(day * DAY_MS + DAY_MS / 2).getUTCDay() + 6) % 7;
}

/** Month index: year * 12 + zero-based month. */
function monthOf(day: number): number {
  const { y, m } = dateOf(day);
  return y * 12 + m;
}

function firstDayOfMonth(month: number): number {
  return Math.floor(Date.UTC(Math.floor(month / 12), month % 12, 1, 12) / DAY_MS);
}

function daysInMonth(month: number): number {
  return firstDayOfMonth(month + 1) - firstDayOfMonth(month);
}

/** Same day-of-month `delta` months away, clamped to that month's last day. */
function addMonths(day: number, delta: number): number {
  const { d } = dateOf(day);
  const target = monthOf(day) + delta;
  return firstDayOfMonth(target) + Math.min(d, daysInMonth(target)) - 1;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const MONTH_NAMES = Array.from({ length: 12 }, (_, m) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, m, 1, 12)),
  ),
);
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const monthTitle = (month: number) => `${MONTH_NAMES[month % 12]} ${Math.floor(month / 12)}`;

/** "Monday 1 February 2027" */
function dayLabel(day: number): string {
  const { y, m, d } = dateOf(day);
  return `${WEEKDAYS[weekdayOf(day)]} ${d} ${MONTH_NAMES[m]} ${y}`;
}

/** Six fixed weeks (42 cells) per month; null for days outside it. */
function monthMatrix(month: number): Array<Array<number | null>> {
  const first = firstDayOfMonth(month);
  const lead = weekdayOf(first);
  const count = daysInMonth(month);
  const weeks: Array<Array<number | null>> = [];
  for (let w = 0; w < 6; w++) {
    const row: Array<number | null> = [];
    for (let c = 0; c < 7; c++) {
      const offset = w * 7 + c - lead;
      row.push(offset >= 0 && offset < count ? first + offset : null);
    }
    weeks.push(row);
  }
  return weeks;
}

/* ------------------------------------------------------------------ */
/* Styles: CSS-only motion (transform + opacity), hover behind (hover).  */
/* ------------------------------------------------------------------ */

const CSS = `
@keyframes hw-cal-from-next { from { opacity: 0; transform: translateX(16px); } }
@keyframes hw-cal-from-prev { from { opacity: 0; transform: translateX(-16px); } }
@keyframes hw-cal-fade { from { opacity: 0; } }
.hw-cal-next { animation: hw-cal-from-next 220ms var(--ease-out) both; }
.hw-cal-prev { animation: hw-cal-from-prev 220ms var(--ease-out) both; }
.hw-cal-day {
  transition: transform 160ms var(--ease-out), background-color 150ms ease, color 150ms ease;
  -webkit-tap-highlight-color: transparent;
}
.hw-cal-day:active:not(:disabled) { transform: scale(0.94); }
.hw-cal-band { transition: background-color 150ms ease; }
@media (hover: hover) {
  .hw-cal-day:not(:disabled):hover { box-shadow: inset 0 0 0 1px var(--color-ink); }
}
@media (prefers-reduced-motion: reduce) {
  .hw-cal-next, .hw-cal-prev { animation-name: hw-cal-fade; }
  .hw-cal-day:active:not(:disabled) { transform: none; }
}
`;

/* ------------------------------------------------------------------ */
/* Day cell                                                             */
/* ------------------------------------------------------------------ */

/** Band shape behind a cell: none, full width, or only the left half (the selected end). */
/** 0 none, 1 full cell, 2 left half (band ends here), 3 right half (band starts here). */
type Band = 0 | 1 | 2 | 3;

interface DayCellProps {
  iso: string;
  date: number;
  label: string;
  descId: string;
  count: number;
  disabled: boolean;
  selected: boolean;
  isToday: boolean;
  tabbable: boolean;
  band: Band;
  roundStart: boolean;
  roundEnd: boolean;
}

const DayCell = memo(function DayCell({
  iso,
  date,
  label,
  descId,
  count,
  disabled,
  selected,
  isToday,
  tabbable,
  band,
  roundStart,
  roundEnd,
}: DayCellProps) {
  const showDot = count > 0 && !disabled;
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      className="relative flex h-10 items-center justify-center sm:h-11"
    >
      <span
        aria-hidden="true"
        className={cn(
          "hw-cal-band absolute inset-y-0 left-0",
          band === 2 ? "right-1/2" : "right-0",
          band === 3 && "left-1/2",
          band === 0 ? "bg-transparent" : "bg-subtle",
          roundStart && "rounded-l-full",
          roundEnd && "rounded-r-full",
        )}
      />
      <button
        type="button"
        data-iso={iso}
        tabIndex={tabbable ? 0 : -1}
        disabled={disabled}
        aria-label={label}
        aria-current={isToday ? "date" : undefined}
        aria-describedby={showDot ? descId : undefined}
        className={cn(
          "hw-cal-day tabular relative flex size-10 items-center justify-center rounded-full text-[14px] leading-none sm:size-11",
          disabled ? "cursor-default text-ink-3" : "cursor-pointer",
          selected ? "bg-ink font-semibold text-white" : "bg-transparent",
          !selected && !disabled && "text-ink",
          isToday && !selected ? "font-semibold" : !selected && "font-medium",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(isToday && !selected && "underline decoration-1 underline-offset-[4px]")}
        >
          {date}
        </span>
        {showDot && (
          <>
            <span
              aria-hidden="true"
              className={cn(
                "absolute bottom-[5px] left-1/2 size-1 -translate-x-1/2 rounded-full sm:bottom-1.5",
                selected ? "bg-white" : "bg-ink-2",
              )}
            />
            <span id={descId} hidden>
              {count === 1 ? "1 home available from this day" : `${count} homes available from this day`}
            </span>
          </>
        )}
      </button>
    </div>
  );
});

function BlankCell() {
  return <div role="gridcell" className="h-10 sm:h-11" />;
}

/* ------------------------------------------------------------------ */
/* Calendar                                                             */
/* ------------------------------------------------------------------ */

interface ViewState {
  /** First visible month (year * 12 + month). */
  first: number;
  /** Direction of the last month change: -1 back, 1 forward, 0 none (no animation). */
  dir: -1 | 0 | 1;
}

const NO_AVAILABILITY: Record<string, number> = {};

export function MoveInCalendar({
  value,
  onChange,
  today,
  minDate,
  availability = NO_AVAILABILITY,
  months = 2,
  maxDate,
  flexDays,
  className,
}: MoveInCalendarProps): JSX.Element {
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);

  const todayN = toDay(today);
  const minN = minDate ? toDay(minDate) : todayN;
  const maxN = Math.max(minN, maxDate ? toDay(maxDate) : addMonths(todayN, 9));
  const valueN = value ? toDay(value) : null;

  const minStart = monthOf(minN);
  const maxStart = Math.max(minStart, monthOf(maxN) - (months - 1));

  const [view, setView] = useState<ViewState>(() => {
    // Selection sits in the last visible month so the band leading up to it shows.
    const anchor = valueN !== null ? monthOf(valueN) - (months - 1) : minStart;
    return { first: clamp(anchor, minStart, maxStart), dir: 0 };
  });
  const [focusedN, setFocusedN] = useState<number>(() =>
    clamp(valueN ?? minN, minN, maxN),
  );

  const first = clamp(view.first, minStart, maxStart);
  const last = first + months - 1;

  const matrices = useMemo(
    () => Array.from({ length: months }, (_, i) => ({ month: first + i, weeks: monthMatrix(first + i) })),
    [first, months],
  );

  // Roving tabindex target: the focused day if visible, else the selection, else the first open day.
  const isVisible = (n: number) => monthOf(n) >= first && monthOf(n) <= last;
  const enabled = (n: number) => n >= minN && n <= maxN;
  let tabbableN: number;
  if (isVisible(focusedN) && enabled(focusedN)) tabbableN = focusedN;
  else if (valueN !== null && isVisible(valueN) && enabled(valueN)) tabbableN = valueN;
  else tabbableN = clamp(firstDayOfMonth(first), minN, maxN);

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    rootRef.current?.querySelector<HTMLButtonElement>(`button[data-iso="${toIso(focusedN)}"]`)?.focus();
  }, [focusedN, first]);

  function shiftView(delta: number) {
    const next = clamp(first + delta, minStart, maxStart);
    if (next !== first) setView({ first: next, dir: delta > 0 ? 1 : -1 });
  }

  function moveFocus(target: number) {
    const next = clamp(target, minN, maxN);
    const m = monthOf(next);
    if (m < first) setView({ first: clamp(m, minStart, maxStart), dir: -1 });
    else if (m > last) setView({ first: clamp(m - (months - 1), minStart, maxStart), dir: 1 });
    focusPending.current = true;
    setFocusedN(next);
    // Same day re-focused (clamped at a bound): the effect won't rerun, so focus directly.
    if (next === focusedN && m >= first && m <= last) {
      focusPending.current = false;
      rootRef.current?.querySelector<HTMLButtonElement>(`button[data-iso="${toIso(next)}"]`)?.focus();
    }
  }

  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-iso]");
    if (!btn || btn.disabled) return;
    const iso = btn.dataset.iso!;
    setFocusedN(toDay(iso));
    onChange(iso);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-iso]");
    if (!btn) return;
    const current = toDay(btn.dataset.iso!);
    let target: number;
    switch (e.key) {
      case "ArrowLeft":
        target = current - 1;
        break;
      case "ArrowRight":
        target = current + 1;
        break;
      case "ArrowUp":
        target = current - 7;
        break;
      case "ArrowDown":
        target = current + 7;
        break;
      case "Home":
        target = current - weekdayOf(current);
        break;
      case "End":
        target = current + (6 - weekdayOf(current));
        break;
      case "PageUp":
        target = addMonths(current, e.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        target = addMonths(current, e.shiftKey ? 12 : 1);
        break;
      default:
        return; // Enter / Space fall through to the native button click.
    }
    e.preventDefault();
    moveFocus(target);
  }

  const animClass = view.dir === 1 ? "hw-cal-next" : view.dir === -1 ? "hw-cal-prev" : undefined;
  const announce =
    months === 1 || Math.floor(first / 12) !== Math.floor(last / 12)
      ? matrices.map((x) => monthTitle(x.month)).join(" – ")
      : `${MONTH_NAMES[first % 12]} – ${monthTitle(last)}`;

  return (
    <div
      ref={rootRef}
      className={cn("relative select-none", months === 1 ? "w-full max-w-[400px]" : "w-max", className)}
    >
      <style href="hw-move-in-calendar" precedence="medium">
        {CSS}
      </style>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-8 items-center justify-between">
        <NavButton label="Previous month" disabled={first <= minStart} onClick={() => shiftView(-1)}>
          <CaretLeftIcon size={16} weight="bold" />
        </NavButton>
        <NavButton label="Next month" disabled={first >= maxStart} onClick={() => shiftView(1)}>
          <CaretRightIcon size={16} weight="bold" />
        </NavButton>
      </div>

      <div
        key={first}
        className={cn("flex gap-12", animClass)}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {matrices.map(({ month, weeks }) => {
          const headingId = `${baseId}-m${month}`;
          const monthLast = firstDayOfMonth(month) + daysInMonth(month) - 1;
          return (
            <div key={month} className={months === 1 ? "w-full" : "w-[308px]"}>
              <h3 id={headingId} className="flex h-8 items-center justify-center text-[16px] font-semibold">
                {monthTitle(month)}
              </h3>
              <div role="grid" aria-labelledby={headingId} className="mt-4">
                <div role="row" className="grid grid-cols-7 pb-2">
                  {WEEKDAYS.map((w) => (
                    <div
                      key={w}
                      role="columnheader"
                      aria-label={w}
                      className="flex h-6 items-center justify-center text-[12px] font-semibold text-ink-2"
                    >
                      {w.slice(0, 2)}
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-0.5">
                  {weeks.map((week, wi) => (
                    <div role="row" key={wi} className="grid grid-cols-7">
                      {week.map((n, ci) => {
                        if (n === null) return <BlankCell key={ci} />;
                        const iso = toIso(n);
                        const date = n - firstDayOfMonth(month) + 1;
                        let band: Band = 0;
                        let roundStart = false;
                        let roundEnd = false;
                        const bandFrom =
                          valueN === null ? null : flexDays === undefined ? minN : Math.max(minN, valueN - flexDays);
                        const bandTo = valueN === null ? null : flexDays === undefined ? valueN : valueN + flexDays;
                        if (bandFrom !== null && bandTo !== null && bandTo > bandFrom && n >= bandFrom && n <= bandTo) {
                          const rowStart = ci === 0 || date === 1;
                          const rowEnd = ci === 6 || n === monthLast;
                          if (n === valueN) {
                            const before = n > bandFrom && !rowStart;
                            const after = n < bandTo && !rowEnd;
                            band = before && after ? 1 : before ? 2 : after ? 3 : 0;
                          } else {
                            band = 1;
                            roundStart = n === bandFrom || rowStart;
                            roundEnd = n === bandTo || rowEnd;
                          }
                        }
                        return (
                          <DayCell
                            key={ci}
                            iso={iso}
                            date={date}
                            label={dayLabel(n)}
                            descId={`${baseId}-${iso}`}
                            count={availability[iso] ?? 0}
                            disabled={!enabled(n)}
                            selected={n === valueN}
                            isToday={n === todayN}
                            tabbable={n === tabbableN}
                            band={band}
                            roundStart={roundStart}
                            roundEnd={roundEnd}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "press pointer-events-auto flex size-8 items-center justify-center rounded-full",
        disabled ? "cursor-default text-ink-3/50" : "text-ink [@media(hover:hover)]:hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}
