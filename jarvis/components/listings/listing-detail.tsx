"use client";

import {
  ArrowUpRightIcon,
  BarbellIcon,
  BicycleIcon,
  BusIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CheckIcon,
  IdentificationCardIcon,
  PersonSimpleWalkIcon,
  QuestionIcon,
  ShoppingCartIcon,
  ThumbsDownIcon,
  XIcon,
} from "@phosphor-icons/react";
import Image from "next/image";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { formatDay, formatEUR, formatMonths, formatRelative } from "@/lib/listings/format";
import { estimateTravel, formatKm } from "@/lib/listings/geo";
import type { CheckStatus, ListingView } from "@/lib/listings/match";
import type { Score } from "@/lib/listings/scores";
import type { FlagField, Listing, SourceKind, TenantKind, TriState } from "@/lib/listings/types";
import { KIND_LABEL, SaveHeart, ScoreChip, availabilityLabel, billsLabel } from "./listing-card";

const FLAG_LABEL: Record<FlagField, string> = {
  bills: "Bills",
  tenancy: "Contract",
  registration: "Registration",
  address: "Address",
  availability: "Availability",
  restrictions: "Who can apply",
  deposit: "Deposit",
  price: "Rent",
  furnishing: "Furnishing",
  size: "Size",
};

const SOURCE_KIND: Record<SourceKind, string> = {
  platform: "Rental platform",
  agent: "Local agent",
  email: "Saved search email",
  group: "Housing group",
};

const FURNISHING: Record<Listing["furnishing"], string> = {
  furnished: "Furnished",
  upholstered: "Upholstered",
  unfurnished: "Unfurnished",
};

interface ListingDetailProps {
  view: ListingView;
  now: string;
  saved: boolean;
  photoIndex: number;
  note: string;
  /** Flag ids the person has ticked off as asked/confirmed. */
  checked: readonly string[];
  onPhotoIndex: (i: number) => void;
  onToggleSave: () => void;
  onPass: () => void;
  onNote: (text: string) => void;
  onToggleCheck: (flagId: string) => void;
  onClose: () => void;
  /** Element to make inert while the dialog is open. */
  appRootId: string;
  /** "TU Delft · Aula": where travel times are measured to. */
  university: string;
}

/**
 * The open listing. It mounts in one commit inside a view transition: the card photo morphs into
 * `hw-photo`, the sheet and backdrop animate as their own compositor layers (globals.css).
 */
export function ListingDetail(props: ListingDetailProps) {
  const { view, now, saved, photoIndex, onClose, appRootId } = props;
  const { listing } = view;
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const actionsRef = useRef({ save: props.onToggleSave, pass: props.onPass });

  useEffect(() => {
    onCloseRef.current = onClose;
    actionsRef.current = { save: props.onToggleSave, pass: props.onPass };
  }, [onClose, props.onToggleSave, props.onPass]);

  // Modal behaviour: inert background, scroll lock, Escape, focus in and back out.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById(appRootId);
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    root?.setAttribute("inert", "");
    html.style.overflow = "hidden";
    // Focus on the next frame: focusing right after `inert` forces a full-page style recalc
    // in the same task as the open, which measurably stalled the first frame.
    const raf = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onCloseRef.current();
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("textarea,input")) return;
      const k = e.key.toLowerCase();
      if (k === "e") return onCloseRef.current();
      if (k === "s") actionsRef.current.save();
      if (k === "d") actionsRef.current.pass();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      root?.removeAttribute("inert");
      html.style.overflow = prevOverflow;
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [appRootId]);

  const photos = listing.photos;
  const main = photos[Math.min(photoIndex, photos.length - 1)];
  const others = photos.map((p, i) => ({ p, i })).filter(({ i }) => i !== photoIndex).slice(0, 4);

  return createPortal(
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-50 bg-black/45"
        style={{ viewTransitionName: "hw-backdrop" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-0 z-50 overflow-y-auto overscroll-contain"
        style={{ viewTransitionName: "hw-sheet" }}
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          className="relative mx-auto min-h-dvh w-full bg-white md:my-6 md:min-h-0 md:w-[min(1160px,calc(100vw-48px))] md:rounded-[28px] md:shadow-[var(--shadow-sheet)]"
        >
          {/* Top bar stays reachable while scrolling a long listing. */}
          <div className="sticky top-0 z-10 flex h-16 items-center justify-between bg-white/95 px-4 md:rounded-t-[28px] md:px-8">
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press -ml-2 grid size-10 place-items-center rounded-full transition-colors hover:bg-hover"
            >
              <XIcon size={18} weight="bold" />
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={props.onToggleSave}
                aria-pressed={saved}
                className="press flex h-10 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold transition-colors hover:bg-hover"
              >
                <SaveHeart saved={saved} size={18} />
                {saved ? "Saved" : "Save"}
              </button>
              <button
                type="button"
                onClick={props.onPass}
                className="press flex h-10 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold transition-colors hover:bg-hover"
              >
                <ThumbsDownIcon size={18} />
                Not for me
              </button>
            </div>
          </div>

          <div className="px-4 pb-28 md:px-8 md:pb-10">
            {/* Gallery. The main photo is the element the card photo morphs into. */}
            <div className="grid gap-2 md:grid-cols-2">
              <div
                data-hero
                className="relative aspect-[20/19] overflow-hidden rounded-2xl bg-hover"
                style={{ viewTransitionName: "hw-photo" }}
              >
                {/* Same URL the card already loaded: decoded instantly, so the morph is never blank. */}
                <Image
                  src={main.src}
                  alt=""
                  aria-hidden="true"
                  fill
                  loading="eager"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 380px"
                  quality={72}
                  className="object-cover"
                />
                <div key={main.src} className="hw-swap absolute inset-0">
                  <Image
                    src={main.src}
                    alt={main.alt}
                    fill
                    preload
                    sizes="(max-width: 768px) 100vw, 580px"
                    quality={85}
                    className="object-cover"
                  />
                </div>
              </div>

              <div
                className={cn(
                  "no-scrollbar flex gap-2 overflow-x-auto md:grid md:grid-cols-2 md:overflow-visible",
                  others.length > 2 ? "md:grid-rows-2" : "md:grid-rows-1",
                )}
              >
                {others.map(({ p, i }, n) => (
                  <button
                    key={p.src}
                    type="button"
                    aria-label={`Show photo ${i + 1}: ${p.alt}`}
                    onClick={() => props.onPhotoIndex(i)}
                    className={cn(
                      "press group/ph relative aspect-[4/3] w-28 shrink-0 overflow-hidden rounded-xl bg-hover md:aspect-auto md:w-auto",
                      others.length === 3 && n === 0 && "md:col-span-2",
                    )}
                  >
                    <Image
                      src={p.src}
                      alt=""
                      fill
                      sizes="(max-width: 768px) 112px, 290px"
                      quality={72}
                      className="object-cover transition-opacity duration-200 group-hover/ph:opacity-90"
                    />
                  </button>
                ))}
              </div>
            </div>

            <div className="select-text mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14">
              <div className="min-w-0">
                <Overview view={view} now={now} titleId={titleId} university={props.university} />
                <FitSection view={view} />
                {listing.flags.length > 0 && (
                  <ConfirmSection view={view} checked={props.checked} onToggle={props.onToggleCheck} />
                )}
                <ScoresSection view={view} />
                <TravelSection view={view} university={props.university} />
                <EligibilitySection listing={listing} />
                <AboutSection listing={listing} />
                <TermsSection listing={listing} now={now} />
                <HistorySection listing={listing} now={now} />
                <div className="lg:hidden">
                  <SourcesBlock listing={listing} now={now} />
                  <NotesBlock note={props.note} onNote={props.onNote} />
                </div>
              </div>

              <aside className="hidden lg:block">
                <div className="sticky top-20 space-y-4">
                  <PriceCard view={view} now={now} />
                  <NotesBlock note={props.note} onNote={props.onNote} compact />
                </div>
              </aside>
            </div>
          </div>

          {/* Mobile action bar */}
          <div className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-between gap-4 border-t border-line-soft bg-white px-5 py-3 lg:hidden">
            <div>
              <p className="text-[16px]">
                <span className="tabular font-semibold">{formatEUR(view.total)}</span> month
              </p>
              <p className="text-[13px] text-ink-2">{billsLabel(view)}</p>
            </div>
            <OriginalAdButton listing={listing} />
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */

function Section({
  title,
  aside,
  children,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line-soft py-8 first:border-t-0 first:pt-0">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="text-[20px] leading-7 font-semibold tracking-[-0.02em]">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Overview({
  view,
  now,
  titleId,
  university,
}: {
  view: ListingView;
  now: string;
  titleId: string;
  university: string;
}) {
  const { listing, travel } = view;
  const { location } = listing;
  const address =
    location.precision === "exact" && location.houseNumber
      ? `${location.street} ${location.houseNumber}, ${location.postcode}`
      : location.precision === "street"
        ? `${location.street} (exact address not given)`
        : `${location.postcode} (only the postcode is given)`;

  const facts: Array<{ icon: React.ReactNode; value: React.ReactNode; label: string }> = [
    {
      icon: <ScoreChip value={view.scores.overall.value} />,
      value: view.scores.overall.value >= 8 ? "Excellent" : view.scores.overall.value >= 7 ? "Good" : "Fair",
      label: "Overall score",
    },
    {
      icon: <BicycleIcon size={20} />,
      value: `${travel.approximate ? "≈ " : ""}${travel.bike} min`,
      label: `to ${university.split(" · ")[0]} by bike`,
    },
    {
      icon: <CalendarBlankIcon size={20} />,
      value: availabilityLabel(listing, now),
      label: listing.tenancy.maxMonths === "indefinite" ? "Open-ended" : "Move-in",
    },
    {
      icon: <IdentificationCardIcon size={20} />,
      value: listing.registration === "yes" ? "Possible" : listing.registration === "no" ? "Not possible" : "Not stated",
      label: "Registration",
    },
  ];

  return (
    <section className="pb-8">
      <h1 id={titleId} className="text-[26px] leading-8 font-semibold tracking-[-0.02em] md:text-[30px] md:leading-9">
        {KIND_LABEL[listing.kind]} in {location.neighbourhood}
      </h1>
      <p className="mt-1.5 text-[16px] text-ink-2">
        {address} · {listing.sizeM2} m² ·{" "}
        {listing.kind === "apartment" ? `${listing.bedrooms} ${listing.bedrooms === 1 ? "bedroom" : "bedrooms"} · ` : ""}
        {FURNISHING[listing.furnishing]}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-y-5 rounded-2xl py-1 sm:grid-cols-4 sm:divide-x sm:divide-line-soft">
        {facts.map((f) => (
          <div key={f.label} className="flex flex-col gap-2 sm:px-5 sm:first:pl-0">
            <span className="flex h-[22px] items-center">{f.icon}</span>
            <dd className="tabular text-[16px] leading-5 font-semibold">{f.value}</dd>
            <dt className="-mt-1.5 text-[13px] text-ink-2">{f.label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

function StatusIcon({ status }: { status: CheckStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full",
        status === "pass" && "bg-ink text-white",
        status === "unknown" && "border border-dashed border-ink-3 text-ink",
        status === "fail" && "text-ink shadow-[inset_0_0_0_1.5px_var(--color-ink)]",
      )}
    >
      {status === "pass" && <CheckIcon size={12} weight="bold" />}
      {status === "unknown" && <QuestionIcon size={12} weight="bold" />}
      {status === "fail" && <XIcon size={11} weight="bold" />}
    </span>
  );
}

const STATUS_TEXT: Record<CheckStatus, string> = { pass: "Fits", unknown: "Unclear", fail: "Doesn't fit" };
const CHECK_TITLE = { budget: "Budget", moveIn: "Move-in", stay: "Stay" } as const;

function FitSection({ view }: { view: ListingView }) {
  return (
    <Section title="Against your search">
      <ul className="grid gap-3 sm:grid-cols-3">
        {view.checks.map((c) => (
          <li key={c.key} className="rounded-2xl bg-subtle p-4">
            <div className="flex items-center gap-2.5">
              <StatusIcon status={c.status} />
              <p className="text-[13px] font-semibold tracking-[0.01em] text-ink-2">
                <span className="sr-only">{STATUS_TEXT[c.status]}: </span>
                {CHECK_TITLE[c.key]}
              </p>
            </div>
            <p className="mt-3 text-[15px] leading-5 font-semibold">{c.label}</p>
            <p className="tabular mt-1 text-[14px] leading-5 text-ink-2">{c.detail}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ConfirmSection({
  view,
  checked,
  onToggle,
}: {
  view: ListingView;
  checked: readonly string[];
  onToggle: (id: string) => void;
}) {
  const { flags } = view.listing;
  const done = flags.filter((f) => checked.includes(f.id)).length;
  return (
    <Section
      title="Before you apply"
      aside={
        <span className="tabular text-[14px] text-ink-2">
          {done} of {flags.length} checked
        </span>
      }
    >
      <ul className="divide-y divide-line-soft">
        {flags.map((f) => {
          const isDone = checked.includes(f.id);
          return (
            <li key={f.id}>
              <label className="flex cursor-pointer gap-4 py-3.5">
                <input
                  type="checkbox"
                  checked={isDone}
                  onChange={() => onToggle(f.id)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink",
                    isDone ? "bg-ink text-white" : "shadow-[inset_0_0_0_1.5px_var(--color-line)]",
                  )}
                >
                  {isDone && <CheckIcon size={12} weight="bold" />}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    {FLAG_LABEL[f.field]}
                    <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink-2">
                      {f.kind === "conflict" ? "Sources disagree" : "Not stated"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "mt-1 block text-[15px] leading-6 transition-colors duration-150",
                      isDone && "text-ink-2 line-through decoration-ink-3",
                    )}
                  >
                    {f.message}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[13px] leading-5 text-ink-2">
        Housewatch only reads what the ads say. Tick these off as you ask the advertiser; only you see this.
      </p>
    </Section>
  );
}

function ScoreRow({ label, score, blurb }: { label: string; score: Score; blurb: string }) {
  return (
    <details className="group border-b border-line-soft last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-4 py-3.5 [&::-webkit-details-marker]:hidden">
        <span className="w-28 shrink-0 text-[15px] font-medium">{label}</span>
        <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-line-soft" aria-hidden="true">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-ink"
            style={{ width: `${score.value * 10}%` }}
          />
        </span>
        <span className="tabular w-9 text-right text-[15px] font-semibold">{score.value.toFixed(1)}</span>
        <CaretDownIcon
          size={14}
          weight="bold"
          className="shrink-0 text-ink-2 transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      <div className="pb-4 pl-32 max-sm:pl-0">
        <p className="text-[13px] leading-5 text-ink-2">{blurb}</p>
        <ul className="mt-2 space-y-1">
          {score.factors.map((f) => (
            <li key={f.label} className="tabular flex justify-between gap-4 text-[13px]">
              <span>{f.label}</span>
              <span className="text-ink-2">
                {label === "Overall" ? f.delta.toFixed(1) : f.delta === 0 ? "" : `${f.delta > 0 ? "+" : ""}${f.delta.toFixed(1)}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function ScoresSection({ view }: { view: ListingView }) {
  const { overall, trust, safety, surroundings } = view.scores;
  return (
    <Section title="Scores" aside={<span className="text-[14px] text-ink-2">Out of 10 · tap for the reasons</span>}>
      <div>
        <ScoreRow label="Overall" score={overall} blurb="A weighted blend of the scores below, your search and value for money." />
        <ScoreRow label="Trust" score={trust} blurb="How far the ad can be relied on: agreeing sources, missing or conflicting details, address precision, freshness." />
        <ScoreRow label="Safety" score={safety} blurb="Neighbourhood baseline, adjusted for what the ad mentions. Indicative only." />
        <ScoreRow label="Surroundings" score={surroundings} blurb="Daily life nearby: groceries, a gym and the city centre." />
      </div>
    </Section>
  );
}

function TravelSection({ view, university }: { view: ListingView; university: string }) {
  const { travel, listing } = view;
  const approx = travel.approximate;
  const gym = estimateTravel(listing.location, listing.nearestGym);
  const modes = [
    { icon: BicycleIcon, label: "Cycling", value: travel.bike },
    { icon: BusIcon, label: travel.transitEstimated ? "Public transport, estimated" : "Public transport", value: travel.transit },
    { icon: PersonSimpleWalkIcon, label: "Walking", value: travel.walk },
  ];
  return (
    <Section
      title="Getting around"
      aside={<span className="tabular text-[14px] text-ink-2">{formatKm(travel.km)} to {university}</span>}
    >
      <div className="grid grid-cols-3 divide-x divide-line-soft">
        {modes.map(({ icon: Icon, label, value }) => (
          <div key={label} className="px-4 first:pl-0">
            <Icon size={20} />
            <p className="tabular mt-2.5 text-[22px] leading-none font-semibold tracking-[-0.02em]">
              {value === null ? "–" : `${approx || (Icon === BusIcon && travel.transitEstimated) ? "≈" : ""}${value}`}
              {value !== null && <span className="ml-1 text-[14px] font-medium tracking-normal">min</span>}
            </p>
            <p className="mt-1.5 text-[13px] text-ink-2">{value === null ? "No timetable data" : label}</p>
          </div>
        ))}
      </div>

      <ul className="mt-6 divide-y divide-line-soft rounded-2xl bg-subtle px-4 text-[15px]">
        <li className="flex items-center gap-3 py-3">
          <ShoppingCartIcon size={18} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{listing.nearestSupermarket.name}</span>
          <span className="tabular text-ink-2">{view.nearby.supermarket} min walk</span>
        </li>
        <li className="flex items-center gap-3 py-3">
          <BarbellIcon size={18} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{listing.nearestGym.name}</span>
          <span className="tabular text-ink-2">
            {gym.walk <= 12 ? `${gym.walk} min walk` : `${gym.bike} min by bike`}
          </span>
        </li>
      </ul>
      <p className="mt-4 text-[12px] leading-4 text-ink-3">
        Walking and cycling routes ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          OpenStreetMap contributors
        </a>
        , routed by FOSSGIS.{" "}
        <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          Fix the map
        </a>
      </p>
      {approx && (
        <p className="mt-2 text-[13px] leading-5 text-ink-2">
          Approximate. The ad gives {listing.location.precision === "street" ? "only the street" : "only the postcode"}, so
          times are measured from its middle.
        </p>
      )}
    </Section>
  );
}

const TENANT_LABEL: Record<TenantKind, string> = {
  bsc: "BSc students",
  msc: "MSc students",
  phd: "PhDs",
  professional: "Working people",
};

function TriBadge({ label, value }: { label: string; value: TriState }) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-full py-1.5 pr-3.5 pl-2 text-[14px]",
        value === "yes" && "bg-subtle",
        value === "no" && "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-soft)]",
        value === "unknown" && "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-soft)]",
      )}
    >
      <StatusIcon status={value === "yes" ? "pass" : value === "no" ? "fail" : "unknown"} />
      <span className={cn(value === "no" && "line-through decoration-ink-3")}>{label}</span>
    </li>
  );
}

function EligibilitySection({ listing }: { listing: Listing }) {
  const e = listing.eligibility;
  if (!e) return null;
  return (
    <Section
      title="Who can apply"
      aside={<span className="text-[14px] text-ink-2">{e.basis === "structured" ? "From the listing" : "Read from the ad text"}</span>}
    >
      <ul className="flex flex-wrap gap-2">
        {(Object.keys(TENANT_LABEL) as TenantKind[]).map((k) => (
          <TriBadge key={k} label={TENANT_LABEL[k]} value={e.tenants[k]} />
        ))}
        <TriBadge label="Couples" value={e.couples} />
        <TriBadge label="Pets" value={e.pets} />
      </ul>
      {listing.restrictions.length > 0 && (
        <p className="mt-4 text-[14px] text-ink-2">The ad says: {listing.restrictions.join(" · ")}</p>
      )}
    </Section>
  );
}

function AboutSection({ listing }: { listing: Listing }) {
  return (
    <Section title="About this place">
      <p className="max-w-[65ch] text-[16px] leading-7">{listing.description}</p>
      {listing.features.length > 0 && (
        <ul className="mt-5 flex flex-wrap gap-2">
          {listing.features.map((f) => (
            <li key={f} className="rounded-full px-3.5 py-1.5 text-[14px] shadow-[inset_0_0_0_1px_var(--color-line)]">
              {f}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function contractText(listing: Listing) {
  const { minMonths, maxMonths } = listing.tenancy;
  if (maxMonths === "indefinite") return minMonths ? `Open-ended, minimum ${formatMonths(minMonths)}` : "Open-ended";
  if (typeof maxMonths === "number")
    return minMonths ? `${formatMonths(minMonths)} to ${formatMonths(maxMonths)}` : `Up to ${formatMonths(maxMonths)}`;
  return minMonths ? `Minimum ${formatMonths(minMonths)}` : "Not stated";
}

function TermsSection({ listing, now }: { listing: Listing; now: string }) {
  const rows: Array<[string, string]> = [
    ["Available", availabilityLabel(listing, now)],
    ["Contract", contractText(listing)],
    ["Registration", listing.registration === "yes" ? "Possible" : listing.registration === "no" ? "Not possible" : "Not stated"],
    ["Furnishing", FURNISHING[listing.furnishing]],
    ["Deposit", listing.costs.deposit === null ? "Not stated" : formatEUR(listing.costs.deposit)],
    ["Size", `${listing.sizeM2} m²`],
  ];
  return (
    <Section title="Terms">
      <dl className="grid grid-cols-2 gap-x-10 gap-y-5 sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[13px] text-ink-2">{k}</dt>
            <dd className="tabular mt-0.5 text-[15px]">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function HistorySection({ listing, now }: { listing: Listing; now: string }) {
  const events = [...listing.history].reverse();
  return (
    <Section title="History">
      <ol>
        {events.map((e, i) => (
          <li key={`${e.date}-${i}`} className="relative flex gap-4 pb-5 last:pb-0">
            {i < events.length - 1 && <span aria-hidden="true" className="absolute top-3 bottom-0 left-[5px] w-px bg-line" />}
            <span
              aria-hidden="true"
              className={cn("relative mt-1.5 size-[11px] shrink-0 rounded-full", i === 0 ? "bg-ink" : "border-2 border-line bg-white")}
            />
            <div>
              <p className="text-[15px]">{e.label}</p>
              <p className="tabular text-[13px] text-ink-2">{formatDay(e.date, now)}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function SourcesBlock({ listing, now }: { listing: Listing; now: string }) {
  return (
    <Section title={listing.sources.length > 1 ? `Listed in ${listing.sources.length} places` : "Where it's listed"}>
      <SourceList listing={listing} now={now} />
    </Section>
  );
}

function SourceList({ listing, now }: { listing: Listing; now: string }) {
  const rents = new Set(listing.sources.map((s) => s.rent));
  return (
    <>
      <ul className="divide-y divide-line-soft">
        {listing.sources.map((s) => (
          <li key={s.id}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group/src flex items-center gap-3 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold group-hover/src:underline">{s.name}</span>
                <span className="block truncate text-[12px] text-ink-2">
                  {SOURCE_KIND[s.kind]} · checked {formatRelative(s.lastCheckedAt, now)}
                </span>
              </span>
              <span className={cn("tabular text-[14px]", rents.size > 1 && "font-semibold")}>{formatEUR(s.rent)}</span>
              <ArrowUpRightIcon size={14} weight="bold" className="text-ink-2" aria-label="opens the ad" />
            </a>
          </li>
        ))}
      </ul>
      {rents.size > 1 && (
        <p className="mt-2 text-[12px] leading-4 text-ink-2">The sources list different base rents. Check which is current.</p>
      )}
    </>
  );
}

function NotesBlock({ note, onNote, compact }: { note: string; onNote: (t: string) => void; compact?: boolean }) {
  const id = useId();
  const field = (
    <textarea
      id={id}
      value={note}
      onChange={(e) => onNote(e.target.value)}
      rows={compact ? 3 : 4}
      placeholder="Viewing times, questions for the landlord, how it felt"
      className="field-sizing-content min-h-20 w-full resize-none rounded-xl bg-subtle px-3.5 py-3 text-[15px] leading-6 outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_2px_var(--color-ink)]"
    />
  );
  if (compact) {
    return (
      <div className="rounded-[20px] p-5 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
        <label htmlFor={id} className="mb-2 flex items-baseline justify-between text-[15px] font-semibold">
          Your notes <span className="text-[12px] font-normal text-ink-2">Only you</span>
        </label>
        {field}
      </div>
    );
  }
  return (
    <Section title={<label htmlFor={id}>Your notes</label>} aside={<span className="text-[14px] text-ink-2">Only you can see this</span>}>
      {field}
    </Section>
  );
}

function OriginalAdButton({ listing }: { listing: Listing }) {
  const primary = listing.sources[0];
  return (
    <a
      href={primary.url}
      target="_blank"
      rel="noopener noreferrer"
      className="press flex h-12 items-center justify-center gap-2 rounded-xl bg-ink px-5 text-[16px] font-semibold text-white"
    >
      View on {primary.name}
      <ArrowUpRightIcon size={16} weight="bold" />
    </a>
  );
}

function PriceCard({ view, now }: { view: ListingView; now: string }) {
  const { costs } = view.listing;
  const rows: Array<[string, string]> = [
    ["Base rent", formatEUR(costs.rent)],
    ["Service costs", costs.serviceCosts === null ? "Not stated" : formatEUR(costs.serviceCosts)],
    ["Utilities", costs.billsIncluded ? "Included" : costs.utilities === null ? "Not stated" : `${formatEUR(costs.utilities)} est.`],
  ];
  return (
    <div className="rounded-[24px] p-6 shadow-[var(--shadow-float)]">
      <p className="text-[26px] leading-8 tracking-[-0.02em]">
        {view.priceDropped && costs.previousRent && (
          <s className="tabular mr-2 text-[18px] text-ink-2">{formatEUR(view.total + (costs.previousRent - costs.rent))}</s>
        )}
        <span className="tabular font-semibold">{formatEUR(view.total)}</span>
        <span className="text-[16px]"> month</span>
      </p>
      <p className="text-[13px] text-ink-2">{view.totalComplete ? "Total, bills included" : "Total before utilities"}</p>

      <dl className="mt-5 space-y-2 text-[14px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-ink-2">{k}</dt>
            <dd className="tabular">{v}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 pt-1 text-ink-2">
          <dt>Deposit, once</dt>
          <dd className="tabular">{costs.deposit === null ? "Not stated" : formatEUR(costs.deposit)}</dd>
        </div>
      </dl>

      <div className="mt-5 grid">
        <OriginalAdButton listing={view.listing} />
      </div>

      <div className="mt-5 border-t border-line-soft pt-3">
        <p className="mb-1 text-[12px] font-semibold tracking-[0.02em] text-ink-2">
          {view.listing.sources.length > 1 ? `Listed in ${view.listing.sources.length} places` : "Listed on"}
        </p>
        <SourceList listing={view.listing} now={now} />
      </div>
      <p className="mt-3 text-[12px] leading-4 text-ink-2">
        You contact the advertiser yourself. Housewatch doesn&apos;t handle applications.
      </p>
    </div>
  );
}
