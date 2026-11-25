"use client";

import { Dialog } from "@base-ui/react/dialog";
import NumberFlow from "@number-flow/react";
import { BellIcon, BellRingingIcon, HeartIcon, ListBulletsIcon, MapTrifoldIcon, XIcon } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Toaster, toast } from "sonner";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/cn";
import { hoverStore } from "@/lib/hover-store";
import { viewListing, type ListingView } from "@/lib/listings/match";
import { EMPTY_FILTERS, countActiveFilters, passesFilters, sortViews, type Filters, type SortKey } from "@/lib/listings/query";
import { median } from "@/lib/listings/scores";
import type { GeoPoint, Listing, SearchCriteria } from "@/lib/listings/types";
import { decodeWithin, runTransition } from "@/lib/view-transition";
import { FiltersPanel } from "./filters-panel";
import { ListingCard } from "./listing-card";
import { ListingDetail } from "./listing-detail";
import { MobileSearch, SearchPill } from "./search";
import { FiltersTab, MapSwitch, SortMenu } from "./toolbar";

const APP_ROOT_ID = "listings-app";
const FILTERS_ID = "listing-filters";

const ListingMap = dynamic(() => import("./listing-map"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#f4f4f2]" />,
});

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

const photoEl = (id: string) => document.querySelector<HTMLElement>(`[data-photo="${CSS.escape(id)}"]`);
const readHomeParam = () => new URLSearchParams(window.location.search).get("home");

interface ListingsExperienceProps {
  listings: Listing[];
  campus: GeoPoint & { name: string };
  now: string;
  initialSearch: SearchCriteria;
}

export function ListingsExperience({ listings, campus, now, initialSearch }: ListingsExperienceProps) {
  const [criteria, setCriteria] = useState(initialSearch);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>("best");
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const [passed, setPassed] = useState<ReadonlySet<string>>(() => new Set());
  const [shortlistOnly, setShortlistOnly] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [photoIndex, setPhotoIndex] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  const [mapOn, setMapOn] = useState(true);
  const [filtersDocked, setFiltersDocked] = useState(true);
  const [filtersSheet, setFiltersSheet] = useState(false);
  const [mobileMap, setMobileMap] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isWide = useMediaQuery("(min-width: 1400px)");
  const showDocked = isWide && filtersDocked;

  // Mount the map the first time it's needed, then keep it (it's expensive to rebuild).
  const [mapWanted, setMapWanted] = useState(false);
  if (((isDesktop && mapOn) || mobileMap) && !mapWanted) setMapWanted(true);

  // Header hairline: an observer on a 1px sentinel instead of a scroll listener.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* ---------------- derived ---------------- */

  const medianPerM2 = useMemo(
    () => median(listings.map((l) => (l.costs.rent + (l.costs.serviceCosts ?? 0)) / Math.max(1, l.sizeM2))),
    [listings],
  );
  const views = useMemo(
    () => listings.map((l) => viewListing(l, criteria, campus, now, medianPerM2)),
    [listings, criteria, campus, now, medianPerM2],
  );
  const live = useMemo(() => views.filter((v) => !passed.has(v.listing.id)), [views, passed]);
  const filtered = useMemo(
    () => sortViews(live.filter((v) => passesFilters(v, filters) && (!shortlistOnly || saved.has(v.listing.id))), sort),
    [live, filters, shortlistOnly, saved, sort],
  );
  const { main, outside } = useMemo(
    () =>
      shortlistOnly
        ? { main: filtered, outside: [] as ListingView[] }
        : { main: filtered.filter((v) => v.status !== "outside"), outside: filtered.filter((v) => v.status === "outside") },
    [filtered, shortlistOnly],
  );
  const mapViews = useMemo(() => [...main, ...outside], [main, outside]);
  const matchCount = main.filter((v) => v.status === "match").length;
  const confirmCount = main.filter((v) => v.status === "confirm").length;
  const openView = openId ? (views.find((v) => v.listing.id === openId) ?? null) : null;
  const liveListings = useMemo(() => listings.filter((l) => !passed.has(l.id)), [listings, passed]);
  const activeFilters = countActiveFilters(filters);

  /* ---------------- animated state changes ---------------- */

  const animate = useCallback((update: () => void) => runTransition("results", update), []);
  const changeFilters = useCallback((f: Filters) => animate(() => setFilters(f)), [animate]);
  const changeCriteria = useCallback((c: SearchCriteria) => animate(() => setCriteria(c)), [animate]);
  const changeCriteriaLive = useCallback((c: SearchCriteria) => setCriteria(c), []);

  /* ---------------- detail + URL ---------------- */

  const openIdRef = useRef(openId);
  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  /** Card photo → hero, as a compositor-driven view transition. */
  const showDetail = useCallback((id: string | null) => {
    const current = openIdRef.current;
    if (id === current) return;
    // Record the target now: Close also pops history, and that popstate must be a no-op.
    openIdRef.current = id;
    if (id) {
      const card = photoEl(id);
      runTransition(
        "detail",
        () => {
          if (card) card.style.viewTransitionName = "";
          setSelectedId(null);
          setOpenId(id);
        },
        {
          before: () => {
            if (card) card.style.viewTransitionName = "hw-photo";
          },
          afterUpdate: () => decodeWithin(document.querySelector<HTMLImageElement>("[data-hero] img")),
        },
      );
    } else if (current) {
      let card: HTMLElement | null = null;
      runTransition("detail", () => setOpenId(null), {
        afterUpdate: () => {
          card = photoEl(current);
          if (card) card.style.viewTransitionName = "hw-photo";
        },
        done: () => {
          if (card) card.style.viewTransitionName = "";
        },
      });
    }
  }, []);

  const openDetail = useCallback(
    (id: string) => {
      hoverStore.set(null);
      showDetail(id);
      const url = new URL(window.location.href);
      url.searchParams.set("home", id);
      window.history.pushState({ hwHome: id }, "", url);
    },
    [showDetail],
  );

  /** Leave the ?home= history entry, so Back and Close always agree. */
  const leaveHomeUrl = useCallback(() => {
    if ((window.history.state as { hwHome?: string } | null)?.hwHome) {
      window.history.back();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete("home");
      window.history.replaceState(null, "", url);
    }
  }, []);

  const closeDetail = useCallback(() => {
    showDetail(null);
    leaveHomeUrl();
  }, [showDetail, leaveHomeUrl]);

  useEffect(() => {
    const sync = () => {
      const id = readHomeParam();
      showDetail(id && listings.some((l) => l.id === id) ? id : null);
    };
    window.addEventListener("popstate", sync);
    if (readHomeParam()) queueMicrotask(sync); // deep link: /listings?home=hw-004
    return () => window.removeEventListener("popstate", sync);
  }, [listings, showDetail]);

  /* ---------------- actions ---------------- */

  const listingById = useMemo(() => new Map(listings.map((l) => [l.id, l])), [listings]);
  const savedRef = useRef(saved);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);

  // Stable identity, so saving one home never re-renders the other cards.
  const toggleSave = useCallback(
    (id: string) => {
      const wasSaved = savedRef.current.has(id);
      setSaved((prev) => {
        const next = new Set(prev);
        if (wasSaved) next.delete(id);
        else next.add(id);
        return next;
      });
      const title = listingById.get(id)?.title ?? "Home";
      toast(wasSaved ? `Removed ${title} from your shortlist` : `Saved ${title} to your shortlist`, { id: `save-${id}` });
    },
    [listingById],
  );

  const pass = useCallback(
    (id: string) => {
      const wasOpen = openIdRef.current === id;
      runTransition("detail", () => {
        setPassed((prev) => new Set(prev).add(id));
        setSelectedId((s) => (s === id ? null : s));
        if (wasOpen) setOpenId(null);
      });
      if (wasOpen) leaveHomeUrl();
      const title = listingById.get(id)?.title ?? "this home";
      toast(`Passed on ${title}`, {
        id: `pass-${id}`,
        description: "Only you can see this.",
        action: {
          label: "Undo",
          onClick: () =>
            runTransition("results", () =>
              setPassed((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              }),
            ),
        },
      });
    },
    [listingById, leaveHomeUrl],
  );

  const setIndexFor = useCallback((id: string, i: number) => {
    setPhotoIndex((prev) => (prev[id] === i ? prev : { ...prev, [id]: i }));
  }, []);

  const toggleFilters = () => {
    if (isWide) animate(() => setFiltersDocked((v) => !v));
    else setFiltersSheet(true);
  };

  const resetAll = () =>
    animate(() => {
      setFilters(EMPTY_FILTERS);
      setShortlistOnly(false);
      setCriteria({ moveInBy: null, stayMonths: null, budget: null });
    });

  /* ---------------- render ---------------- */

  const resultSummary = shortlistOnly
    ? "Private to you. Saving a home never contacts the advertiser."
    : main.length === 0
      ? "Nothing fits every part of your search yet."
      : `${matchCount} fit your search${confirmCount ? `, ${confirmCount} with details to confirm` : ""}`;

  return (
    <>
      <div id={APP_ROOT_ID} className="min-h-dvh">
        <div ref={sentinelRef} aria-hidden="true" className="absolute top-0 h-px w-px" />

        {/* ---------- Header + toolbar ---------- */}
        <div className="hw-header sticky top-0 z-40 bg-white">
          <header className="relative z-20 flex h-[var(--header-h)] items-center gap-3 px-5 sm:px-6 xl:px-10">
            <Link href="/listings" aria-label="Housewatch, all homes" className="shrink-0 xl:min-w-[220px]">
              <Logo />
            </Link>
            <div className="hidden flex-1 justify-center lg:flex">
              <SearchPill
                criteria={criteria}
                onChange={changeCriteria}
                onChangeLive={changeCriteriaLive}
                listings={liveListings}
                now={now}
              />
            </div>
            <div className="min-w-0 flex-1 lg:hidden">
              <MobileSearch
                criteria={criteria}
                onChange={changeCriteria}
                onChangeLive={changeCriteriaLive}
                listings={liveListings}
                now={now}
                resultCount={main.length}
              />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-1 xl:min-w-[220px]">
              <button
                type="button"
                aria-label="Alerts for new matches"
                aria-pressed={alerts}
                onClick={() => {
                  setAlerts((a) => !a);
                  toast(alerts ? "Alerts off" : "Alerts on", {
                    id: "alerts",
                    description: alerts ? undefined : "New matches for this search will reach you by email.",
                  });
                }}
                className="press hidden h-11 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold transition-colors hover:bg-hover sm:flex"
              >
                {alerts ? <BellRingingIcon size={18} weight="fill" /> : <BellIcon size={18} />}
                <span className="hidden xl:inline">Alerts</span>
              </button>
              <button
                type="button"
                aria-label={saved.size ? `Shortlist, ${saved.size} saved` : "Shortlist"}
                aria-pressed={shortlistOnly}
                onClick={() => animate(() => setShortlistOnly((s) => !s))}
                className={cn(
                  "press flex h-11 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold transition-colors duration-150",
                  shortlistOnly ? "bg-ink text-white" : "hover:bg-hover",
                )}
              >
                <HeartIcon size={18} weight={shortlistOnly || saved.size > 0 ? "fill" : "regular"} />
                <span className="hidden xl:inline">Shortlist</span>
                {saved.size > 0 && (
                  <span
                    key={saved.size}
                    className={cn(
                      "hw-pop tabular grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] leading-none",
                      shortlistOnly ? "bg-white text-ink" : "bg-ink text-white",
                    )}
                  >
                    {saved.size}
                  </span>
                )}
              </button>
            </div>
          </header>

          <div
            className={cn(
              "flex h-[var(--toolbar-h)] items-center gap-3 border-b px-5 transition-[border-color,box-shadow] duration-200 sm:px-6 xl:px-10",
              scrolled ? "border-line-soft shadow-[0_6px_16px_-12px_rgb(0_0_0/0.18)]" : "border-transparent",
            )}
          >
            <FiltersTab
              open={showDocked || filtersSheet}
              count={activeFilters}
              onToggle={toggleFilters}
              controls={FILTERS_ID}
            />
            <div className="hw-results-head min-w-0 flex-1 pl-1">
              <h1 className="truncate text-[17px] leading-6 font-semibold tracking-[-0.01em]">
                {shortlistOnly ? (
                  "Your shortlist"
                ) : (
                  <>
                    <NumberFlow value={main.length} className="tabular" /> {main.length === 1 ? "home" : "homes"}
                    <span className="hidden sm:inline"> in Delft</span>
                  </>
                )}
              </h1>
              <p className="hidden truncate text-[13px] text-ink-2 sm:block">{resultSummary}</p>
            </div>
            <SortMenu value={sort} onChange={(s) => animate(() => setSort(s))} />
            <div className="hidden lg:block">
              <MapSwitch on={mapOn} onChange={(v) => animate(() => setMapOn(v))} />
            </div>
          </div>
        </div>

        {/* ---------- Body ---------- */}
        <div className="flex gap-8 px-5 sm:px-6 xl:px-10">
          {showDocked && (
            <aside
              id={FILTERS_ID}
              aria-label="Filters"
              className="hw-filters-panel sticky top-[calc(var(--header-h)+var(--toolbar-h))] h-[calc(100dvh-var(--header-h)-var(--toolbar-h))] w-[288px] shrink-0 overflow-y-auto overscroll-contain py-6 pr-2 [scrollbar-width:thin]"
            >
              <FiltersPanel filters={filters} onChange={changeFilters} resultCount={main.length} />
            </aside>
          )}

          <main className="min-w-0 flex-1 pt-6 pb-24">
            {main.length === 0 ? (
              <EmptyState
                shortlist={shortlistOnly}
                hasFilters={activeFilters > 0}
                onReset={resetAll}
                onLeaveShortlist={() => animate(() => setShortlistOnly(false))}
              />
            ) : (
              <CardGrid
                views={main}
                saved={saved}
                photoIndex={photoIndex}
                now={now}
                onToggleSave={toggleSave}
                onOpen={openDetail}
                onPhotoIndex={setIndexFor}
              />
            )}

            {outside.length > 0 && (
              <section className="mt-16 border-t border-line-soft pt-10" aria-labelledby="outside-title">
                <h2 id="outside-title" className="text-[19px] leading-6 font-semibold tracking-[-0.02em]">
                  Close, but outside your search
                </h2>
                <p className="mt-0.5 mb-6 text-[14px] text-ink-2">
                  Each of these misses on budget, move-in date or contract length.
                </p>
                <CardGrid
                  views={outside}
                  saved={saved}
                  photoIndex={photoIndex}
                  now={now}
                  offset={main.length}
                  onToggleSave={toggleSave}
                  onOpen={openDetail}
                  onPhotoIndex={setIndexFor}
                />
              </section>
            )}

            <footer className="mt-20 max-w-[60ch] border-t border-line-soft pt-6 text-[13px] leading-5 text-ink-2">
              Housewatch collects listings from rental platforms, local agents, saved-search emails and housing groups you
              connect. Coverage varies by source. Scores are estimates with their reasons shown. Always confirm details with
              the original advertiser before you apply.
            </footer>
          </main>

          <aside
            aria-label="Map"
            className={cn(
              "hw-map-panel lg:sticky lg:top-[calc(var(--header-h)+var(--toolbar-h))] lg:h-[calc(100dvh-var(--header-h)-var(--toolbar-h))] lg:shrink-0 lg:py-6",
              showDocked ? "lg:w-[36%]" : "lg:w-[40%] 2xl:w-[38%]",
              mapOn ? "lg:block" : "lg:hidden",
              mobileMap
                ? "fixed inset-x-0 top-[calc(var(--header-h)+var(--toolbar-h))] bottom-0 z-30 block lg:static"
                : "hidden",
            )}
          >
            <div className="h-full overflow-hidden lg:rounded-[20px]">
              {mapWanted && (
                <ListingMap
                  listings={listings}
                  views={mapViews}
                  campus={campus}
                  selectedId={selectedId}
                  openId={openId}
                  savedIds={saved}
                  onSelect={setSelectedId}
                  onOpen={openDetail}
                />
              )}
            </div>
          </aside>
        </div>

        {/* Mobile map toggle */}
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center lg:hidden">
          <button
            type="button"
            onClick={() => setMobileMap((m) => !m)}
            className="press pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-semibold text-white shadow-[var(--shadow-float)]"
          >
            <span key={mobileMap ? "list" : "map"} className="hw-swap flex items-center gap-2">
              {mobileMap ? "Show list" : "Show map"}
              {mobileMap ? <ListBulletsIcon size={18} weight="bold" /> : <MapTrifoldIcon size={18} weight="bold" />}
            </span>
          </button>
        </div>
      </div>

      {/* Filters as a sheet below the docking width: from the left on desktop, full screen on phones. */}
      <Dialog.Root open={filtersSheet && !showDocked} onOpenChange={setFiltersSheet}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/35 transition-opacity duration-300 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup
            id={FILTERS_ID}
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex w-full flex-col bg-white outline-none sm:w-[400px] sm:rounded-r-[28px] sm:shadow-[var(--shadow-sheet)]",
              "transition-[translate] duration-[380ms] ease-[var(--ease-drawer)]",
              "data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full",
            )}
          >
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-line-soft px-5">
              <Dialog.Title className="text-[16px] font-semibold">Filters</Dialog.Title>
              <Dialog.Close
                aria-label="Close filters"
                className="press grid size-9 place-items-center rounded-full transition-colors hover:bg-hover"
              >
                <XIcon size={16} weight="bold" />
              </Dialog.Close>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-28">
              <FiltersPanel filters={filters} onChange={(f) => setFilters(f)} resultCount={main.length} inSheet />
            </div>
            <div className="absolute inset-x-0 bottom-0 border-t border-line-soft bg-white p-4">
              <Dialog.Close className="press flex h-12 w-full items-center justify-center rounded-xl bg-ink text-[16px] font-semibold text-white">
                <span>
                  Show <NumberFlow value={main.length} className="tabular" /> {main.length === 1 ? "home" : "homes"}
                </span>
              </Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {openView && (
        <ListingDetail
          key={openView.listing.id}
          view={openView}
          now={now}
          saved={saved.has(openView.listing.id)}
          photoIndex={photoIndex[openView.listing.id] ?? 0}
          note={notes[openView.listing.id] ?? ""}
          checked={checked[openView.listing.id] ?? []}
          onPhotoIndex={(i) => setIndexFor(openView.listing.id, i)}
          onToggleSave={() => toggleSave(openView.listing.id)}
          onPass={() => pass(openView.listing.id)}
          onNote={(text) => setNotes((prev) => ({ ...prev, [openView.listing.id]: text }))}
          onToggleCheck={(flagId) =>
            setChecked((prev) => {
              const list = prev[openView.listing.id] ?? [];
              return {
                ...prev,
                [openView.listing.id]: list.includes(flagId) ? list.filter((x) => x !== flagId) : [...list, flagId],
              };
            })
          }
          onClose={closeDetail}
          appRootId={APP_ROOT_ID}
        />
      )}

      <Toaster
        position="bottom-center"
        offset={24}
        mobileOffset={88}
        gap={8}
        toastOptions={{
          classNames: {
            toast:
              "!rounded-2xl !border-0 !bg-ink !px-4 !py-3.5 !text-white !shadow-[var(--shadow-sheet)] !font-[inherit] !gap-3",
            title: "!text-[14px] !font-semibold",
            description: "!text-[13px] !text-white/70",
            actionButton:
              "!h-8 !rounded-lg !bg-white !px-3 !text-[13px] !font-semibold !text-ink transition-transform active:scale-[0.97]",
          },
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */

interface CardGridProps {
  views: ListingView[];
  saved: ReadonlySet<string>;
  photoIndex: Record<string, number>;
  now: string;
  offset?: number;
  onToggleSave: (id: string) => void;
  onOpen: (id: string) => void;
  onPhotoIndex: (id: string, i: number) => void;
}

/**
 * Plain grid: no per-card layout tracking. When results change inside a view transition, each
 * card gets a `view-transition-name` (globals.css) and the browser animates it on the compositor.
 */
const CardGrid = memo(function CardGrid({
  views,
  saved,
  photoIndex,
  now,
  offset = 0,
  onToggleSave,
  onOpen,
  onPhotoIndex,
}: CardGridProps) {
  // Only cards present on the very first render get the CSS entrance.
  const [firstIds] = useState(() => new Set(views.map((v) => v.listing.id)));
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(true), 1200);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-10 min-[560px]:grid-cols-2 md:grid-cols-[repeat(auto-fill,minmax(230px,1fr))]">
      {views.map((view, i) => {
        const id = view.listing.id;
        const rise = !settled && firstIds.has(id);
        return (
          <li
            key={id}
            className={cn("hw-card", rise && "hw-rise")}
            style={
              {
                "--vt-name": `card-${id}`,
                animationDelay: rise ? `${0.05 + Math.min(offset + i, 6) * 0.05}s` : undefined,
              } as React.CSSProperties
            }
          >
            <ListingCard
              view={view}
              now={now}
              saved={saved.has(id)}
              photoIndex={photoIndex[id] ?? 0}
              priority={offset + i < 4}
              onToggleSave={onToggleSave}
              onOpen={onOpen}
              onPhotoIndex={onPhotoIndex}
            />
          </li>
        );
      })}
    </ul>
  );
});

function EmptyState({
  shortlist,
  hasFilters,
  onReset,
  onLeaveShortlist,
}: {
  shortlist: boolean;
  hasFilters: boolean;
  onReset: () => void;
  onLeaveShortlist: () => void;
}) {
  return (
    <div className="hw-swap rounded-[24px] bg-subtle px-8 py-14 text-center">
      <p className="text-[19px] font-semibold tracking-[-0.02em]">
        {shortlist ? "Nothing saved yet" : "No homes fit all of that"}
      </p>
      <p className="mx-auto mt-1.5 max-w-[42ch] text-[15px] text-ink-2">
        {shortlist
          ? "Tap the heart on a home to keep it here. It stays private to you."
          : hasFilters
            ? "Try removing a filter, or widen your budget or move-in date."
            : "Try a wider budget or a later move-in date."}
      </p>
      <button
        type="button"
        onClick={shortlist ? onLeaveShortlist : onReset}
        className="press mt-6 h-11 rounded-xl px-5 text-[15px] font-semibold shadow-[inset_0_0_0_1px_var(--color-ink)]"
      >
        {shortlist ? "Browse all homes" : "Reset search and filters"}
      </button>
    </div>
  );
}
