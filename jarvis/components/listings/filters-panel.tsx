"use client";

import { Switch } from "@base-ui/react/switch";
import { BedIcon, BuildingsIcon, CheckIcon, DoorOpenIcon, InfoIcon, type Icon } from "@phosphor-icons/react";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { EMPTY_FILTERS, countActiveFilters, type CommuteMode, type Filters } from "@/lib/listings/query";
import type { Furnishing, ListingKind, TenantKind } from "@/lib/listings/types";

/* ------------------------------------------------------------------ */
/* Small controls. All state changes are colour/opacity only.          */
/* ------------------------------------------------------------------ */

function Pill({
  selected,
  onClick,
  children,
  icon: IconCmp,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: Icon;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "press inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors duration-150",
        selected
          ? "bg-ink text-white"
          : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-ink)]",
      )}
    >
      {IconCmp && <IconCmp size={16} weight={selected ? "fill" : "regular"} />}
      {children}
    </button>
  );
}

function Choice<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "press h-8 rounded-full px-3 text-[13px] transition-colors duration-150",
            o.value === value
              ? "bg-ink font-semibold text-white"
              : "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--color-ink)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-[14px] font-medium">{label}</span>
        {description && <span className="block text-[12px] leading-4 text-ink-2">{description}</span>}
      </label>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="relative flex h-6 w-10 shrink-0 rounded-full bg-line p-0.5 transition-colors duration-200 data-[checked]:bg-ink"
      >
        <Switch.Thumb className="group grid size-5 place-items-center rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[translate] duration-200 ease-[var(--ease-out)] data-[checked]:translate-x-4">
          <CheckIcon
            size={10}
            weight="bold"
            className="opacity-0 transition-opacity duration-150 group-data-[checked]:opacity-100"
          />
        </Switch.Thumb>
      </Switch.Root>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line-soft py-5 last:border-b-0">
      <h3 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em]">
        {title}
        {hint && (
          <span title={hint} className="text-ink-3">
            <InfoIcon size={14} aria-label={hint} />
          </span>
        )}
      </h3>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-ink-2">{label}</p>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const KINDS: Array<{ value: ListingKind; label: string; icon: Icon }> = [
  { value: "room", label: "Rooms", icon: BedIcon },
  { value: "studio", label: "Studios", icon: DoorOpenIcon },
  { value: "apartment", label: "Apartments", icon: BuildingsIcon },
];

const MODES: Array<{ value: CommuteMode; label: string }> = [
  { value: "bike", label: "Bike" },
  { value: "transit", label: "Public transport" },
  { value: "walk", label: "Walk" },
];

const TENANTS: Array<{ value: TenantKind | null; label: string }> = [
  { value: null, label: "Anyone" },
  { value: "bsc", label: "BSc student" },
  { value: "msc", label: "MSc student" },
  { value: "phd", label: "PhD" },
  { value: "professional", label: "Working" },
];

const SCORE_STEPS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Any" },
  { value: 6, label: "6+" },
  { value: 7, label: "7+" },
  { value: 8, label: "8+" },
];

const FURNISHING: Array<{ value: Furnishing | null; label: string }> = [
  { value: null, label: "Any" },
  { value: "furnished", label: "Furnished" },
  { value: "upholstered", label: "Upholstered" },
  { value: "unfurnished", label: "Unfurnished" },
];

const minutes = (values: number[]) => [
  { value: null as number | null, label: "Any" },
  ...values.map((v) => ({ value: v as number | null, label: `${v} min` })),
];

export function FiltersPanel({
  filters,
  onChange,
  resultCount,
  inSheet = false,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  resultCount: number;
  /** In the sheet the title already sits in the sheet header. */
  inSheet?: boolean;
}) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onChange({ ...filters, [key]: value });
  const active = countActiveFilters(filters);
  const toggleKind = (k: ListingKind) =>
    set("kinds", filters.kinds.includes(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k]);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 pb-1">
        {inSheet ? (
          <p className="tabular text-[14px] text-ink-2">{active > 0 ? `${active} filters on` : "No filters on"}</p>
        ) : (
          <h2 className="text-[19px] font-semibold tracking-[-0.02em]">
            Filters
            {active > 0 && <span className="tabular ml-2 text-[14px] font-medium text-ink-2">{active} on</span>}
          </h2>
        )}
        <button
          type="button"
          disabled={active === 0}
          onClick={() => onChange(EMPTY_FILTERS)}
          className="text-[13px] font-semibold underline underline-offset-4 transition-opacity disabled:pointer-events-none disabled:opacity-0"
        >
          Clear all
        </button>
      </div>
      {!inSheet && (
        <p className="tabular text-[13px] text-ink-2">
          {resultCount} {resultCount === 1 ? "home matches" : "homes match"}
        </p>
      )}

      <Section title="Type">
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <Pill key={k.value} icon={k.icon} selected={filters.kinds.includes(k.value)} onClick={() => toggleKind(k.value)}>
              {k.label}
            </Pill>
          ))}
        </div>
      </Section>

      <Section title="Time to TU Delft" hint="Estimated door to door to TU Delft Aula. Public transport uses timetable data where the source has it.">
        <Choice label="Travel by" value={filters.commuteMode} options={MODES} onChange={(v) => set("commuteMode", v)} />
        <Row label="At most">
          <Choice
            label="Maximum travel time"
            value={filters.maxCommute}
            options={minutes(filters.commuteMode === "walk" ? [15, 20, 30, 40] : [10, 15, 20, 30])}
            onChange={(v) => set("maxCommute", v)}
          />
        </Row>
      </Section>

      <Section title="Nearby" hint="Walking time to the nearest supermarket and gym.">
        <Row label="Supermarket on foot">
          <Choice label="Supermarket on foot" value={filters.maxSupermarketWalk} options={minutes([5, 10, 15])} onChange={(v) => set("maxSupermarketWalk", v)} />
        </Row>
        <Row label="Gym on foot">
          <Choice label="Gym on foot" value={filters.maxGymWalk} options={minutes([5, 10, 15, 20])} onChange={(v) => set("maxGymWalk", v)} />
        </Row>
      </Section>

      <Section
        title="Who can apply"
        hint="Read from the ad text. Ads that exclude you are hidden; ads that don't say are kept and marked to confirm."
      >
        <Row label="I'm a">
          <Choice label="I'm a" value={filters.tenant} options={TENANTS} onChange={(v) => set("tenant", v)} />
        </Row>
        <div className="-my-1">
          <Toggle label="Moving in as a couple" checked={filters.couples} onChange={(v) => set("couples", v)} />
          <Toggle label="Bringing a pet" checked={filters.pets} onChange={(v) => set("pets", v)} />
        </div>
      </Section>

      <Section title="Scores" hint="Out of 10. Open a home to see what each score is made of.">
        <Row label="Overall">
          <Choice label="Minimum overall score" value={filters.minOverall} options={SCORE_STEPS} onChange={(v) => set("minOverall", v)} />
        </Row>
        <Row label="Trust: how reliable the ad is">
          <Choice label="Minimum trust score" value={filters.minTrust} options={SCORE_STEPS} onChange={(v) => set("minTrust", v)} />
        </Row>
        <Row label="Safety">
          <Choice label="Minimum safety score" value={filters.minSafety} options={SCORE_STEPS} onChange={(v) => set("minSafety", v)} />
        </Row>
        <Row label="Surroundings">
          <Choice label="Minimum surroundings score" value={filters.minSurroundings} options={SCORE_STEPS} onChange={(v) => set("minSurroundings", v)} />
        </Row>
      </Section>

      <Section title="The home">
        <Row label="Size">
          <Choice
            label="Minimum size"
            value={filters.minSize}
            options={[
              { value: null, label: "Any" },
              { value: 15, label: "15 m²+" },
              { value: 25, label: "25 m²+" },
              { value: 40, label: "40 m²+" },
            ]}
            onChange={(v) => set("minSize", v)}
          />
        </Row>
        <Row label="Furnishing">
          <Choice label="Furnishing" value={filters.furnishing} options={FURNISHING} onChange={(v) => set("furnishing", v)} />
        </Row>
        <div className="-my-1">
          <Toggle
            label="Registration possible"
            description="You can register this address."
            checked={filters.registrationOnly}
            onChange={(v) => set("registrationOnly", v)}
          />
          <Toggle label="Bills included" checked={filters.billsIncludedOnly} onChange={(v) => set("billsIncludedOnly", v)} />
          <Toggle
            label="Only fully confirmed"
            description="Hide ads with missing or conflicting details."
            checked={filters.confirmedOnly}
            onChange={(v) => set("confirmedOnly", v)}
          />
        </div>
      </Section>
    </div>
  );
}
