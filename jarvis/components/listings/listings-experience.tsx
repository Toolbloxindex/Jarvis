"use client";

import { Dialog } from "@base-ui/react/dialog";
import NumberFlow from "@number-flow/react";
import {
  HeartIcon,
  ListBulletsIcon,
  MapTrifoldIcon,
  ThumbsDownIcon,
  XIcon,
} from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Toaster, toast } from "sonner";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/cn";
import { hoverStore } from "@/lib/hover-store";
import { formatRelative } from "@/lib/listings/format";
import { viewListing, type ListingView } from "@/lib/listings/match";
import { EMPTY_FILTERS, countActiveFilters, passesFilters, sortViews, type Filters, type SortKey } from "@/lib/listings/query";
import { median } from "@/lib/listings/scores";
import type { Listing, SearchCriteria } from "@/lib/listings/types";
import { usePersisted, usePersistedSet } from "@/lib/persist";
import type { SyncConfig } from "@/lib/sync";
import { universityById } from "@/lib/universities";
import { dropStyle, flyIntoStyle } from "@/lib/card-motion";
import { decodeWithin, runTransition } from "@/lib/view-transition";
import { FiltersPanel } from "./filters-panel";
import { ListingCard } from "./listing-card";
import { ListingDetail } from "./listing-detail";
import { MobileSearch, SearchPill } from "./search";
import { TriageHint, useTriage } from "./triage";
import { SyncControl } from "./sync-control";
import { AlertsControl } from "./alerts-control";
import { FiltersTab, MapSwitch, SortMenu } from "./toolbar";

const APP_ROOT_ID = "listings-app";
const EMPTY_RECORD: Record<string, string> = {};
const EMPTY_CHECKS: Record<string, string[]> = {};
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
  now: string;
  initialSearch: SearchCriteria;
  /** Latest collector change (ISO), or null before the first collection. */
  updatedAt?: string | null;
  /** No real data yet: the first collection is still running. */
  collecting?: boolean;
  /** Public Supabase settings for account-free sync between devices; null turns sync off. */
  sync?: SyncConfig | null;
}

export function ListingsExperience({
  listings,
  now,
  initialSearch,
  updatedAt = null,
  collecting = false,
  sync = null,
}: ListingsExperienceProps) {
  // Personal state is local-first: it survives reloads and new tabs (lib/persist.ts).
  const [criteria, setCriteria] = usePersisted<SearchCriteria>("search", initialSearch);
  const [filters, setFilters] = usePersisted<Filters>("filters", EMPTY_FILTERS);
  const [sort, setSort] = usePersisted<SortKey>("sort", "best");
  const [savedList, setSaved] = usePersistedSet("saved");
  const [passedList, setPassed] = usePersistedSet("passed");
  const saved = useMemo<ReadonlySet<string>>(() => new Set(savedList), [savedList]);
  const passed = useMemo<ReadonlySet<string>>(() => new Set(passedList), [passedList]);
  /** all = the feed; saved / passed = those lists. Saved and passed homes leave the feed. */
  const [view, setView] = useState<"all" | "saved" | "passed">("all");
  /** Just-saved homes stay in the feed for a beat, so the heart can pop before they fly off. */
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [savedBump, setSavedBump] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [photoIndex, setPhotoIndex] = useState<Record<string, number>>({});
  const [notes, setNotes] = usePersisted<Record<string, string>>("notes", EMPTY_RECORD);
  const [checked, setChecked] = usePersisted<Record<string, string[]>>("checked", EMPTY_CHECKS);
  const [mapOn, setMapOn] = usePersisted("mapOn", true);
  const [filtersDocked, setFiltersDocked] = usePersisted("filtersDocked", true);

  const [filtersSheet, setFiltersSheet] = useState(false);
  const [mobileMap, setMobileMap] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [passedBump, setPassedBump] = useState(0);
  const isMobile = useMediaQuery("(max-width: 1023px)");

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

  const university = useMemo(() => universityById(criteria.university), [criteria.university]);
  const campus = useMemo(() => ({ ...university, name: `${university.short} · ${university.place}` }), [university]);
  const medianPerM2 = useMemo(
    () => median(listings.map((l) => (l.costs.rent + (l.costs.serviceCosts ?? 0)) / Math.max(1, l.sizeM2))),
    [listings],
  );
  const views = useMemo(
    () => listings.map((l) => viewListing(l, criteria, university, now, medianPerM2)),
    [listings, criteria, university, now, medianPerM2],
  );
  const listView = view !== "all";
  const filtered = useMemo(() => {
    const inView = (v: ListingView) => {
      const id = v.listing.id;
      if (view === "passed") return passed.has(id);
      if (passed.has(id)) return false;
      if (view === "saved") return saved.has(id);
      return !saved.has(id) || savingIds.has(id);
    };
    return sortViews(views.filter(inView), sort);
  }, [views, view, passed, saved, savingIds, sort]);
  // Filtering hides cards instead of unmounting them: a filter change flips an attribute rather
  // than tearing down and re-creating cards (carousels, images). Lists ignore filters.
  const hiddenIds = useMemo<ReadonlySet<string>>(
    () => (listView ? new Set() : new Set(filtered.filter((v) => !passesFilters(v, filters)).map((v) => v.listing.id))),
    [filtered, filters, listView],
  );
  const { mainAll, outsideAll } = useMemo(
    () =>
      listView
        ? { mainAll: filtered, outsideAll: [] as ListingView[] }
        : {
            mainAll: filtered.filter((v) => v.status !== "outside"),
            outsideAll: filtered.filter((v) => v.status === "outside"),
          },
    [filtered, listView],
  );
  const main = useMemo(() => mainAll.filter((v) => !hiddenIds.has(v.listing.id)), [mainAll, hiddenIds]);
  const outside = useMemo(() => outsideAll.filter((v) => !hiddenIds.has(v.listing.id)), [outsideAll, hiddenIds]);
  const mapViews = useMemo(() => [...main, ...outside], [main, outside]);
  const matchCount = main.filter((v) => v.status === "match").length;
  const confirmCount = main.filter((v) => v.status === "confirm").length;
  const openView = openId ? (views.find((v) => v.listing.id === openId) ?? null) : null;
  const liveListings = useMemo(() => listings.filter((l) => !passed.has(l.id)), [listings, passed]);
  const activeFilters = countActiveFilters(filters);

  /* ---------------- animated state changes ---------------- */

  const animate = useCallback((update: () => void) => runTransition("results", update), []);
  const changeFilters = useCallback((f: Filters) => animate(() => setFilters(f)), [animate, setFilters]);
  const changeCriteria = useCallback((c: SearchCriteria) => animate(() => setCriteria(c)), [animate, setCriteria]);
  const changeCriteriaLive = useCallback((c: SearchCriteria) => setCriteria(c), [setCriteria]);

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

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /**
   * Save: the heart pops in place, then the card arcs into the Saved button and the grid closes
   * up. Unsaving inside the Saved list just drops the card. Stable identity for the memo'd cards.
   */
  const toggleSave = useCallback((id: string) => {
    const wasSaved = savedRef.current.has(id);
    const inGrid = !!document.querySelector(`[data-card-id="${CSS.escape(id)}"]`) && openIdRef.current !== id;
    if (wasSaved) {
      const remove = () =>
        setSaved((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      if (viewRef.current === "saved" && inGrid) {
        const style = dropStyle(id);
        runTransition("results", remove, { before: () => document.head.append(style), done: () => style.remove() });
      } else remove();
      return;
    }
    if (!inGrid || viewRef.current !== "all") {
      setSaved((prev) => new Set(prev).add(id));
      setSavedBump((b) => b + 1);
      return;
    }
    setSaved((prev) => new Set(prev).add(id));
    setSavingIds((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      const style = flyIntoStyle(id, "saved-bin");
      runTransition(
        "results",
        () =>
          setSavingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          }),
        {
          before: () => document.head.append(style),
          done: () => {
            style.remove();
            setSavedBump((b) => b + 1);
          },
        },
      );
    }, 90);
  }, [setSaved]);

  const passedStack = useRef<string[]>([]);
  const unpass = useCallback((id: string) => {
    passedStack.current = passedStack.current.filter((x) => x !== id);
    const style = viewRef.current === "passed" ? dropStyle(id) : null;
    runTransition(
      "results",
      () =>
        setPassed((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      { before: () => style && document.head.append(style), done: () => style?.remove() },
    );
  }, [setPassed]);

  const pass = useCallback(
    (id: string) => {
      const wasOpen = openIdRef.current === id;
      passedStack.current.push(id);
      const apply = () => {
        setPassed((prev) => new Set(prev).add(id));
        setSaved((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setSelectedId((s) => (s === id ? null : s));
        if (wasOpen) setOpenId(null);
      };
      if (wasOpen) {
        runTransition("detail", apply);
        leaveHomeUrl();
      } else {
        // A quick drop in place; the grid closes the gap around it.
        const style = dropStyle(id);
        runTransition("results", apply, {
          before: () => document.head.append(style),
          done: () => {
            style.remove();
            setPassedBump((b) => b + 1);
          },
        });
      }
      const title = listingById.get(id)?.title ?? "this home";
      toast(`Passed on ${title}`, {
        id: `pass-${id}`,
        description: "It's under Passed if you change your mind.",
        action: { label: "Undo", onClick: () => unpass(id) },
      });
    },
    [listingById, leaveHomeUrl, unpass, setPassed, setSaved],
  );

  const undoLastPass = useCallback(() => {
    const id = passedStack.current.at(-1);
    if (!id) return;
    unpass(id);
    toast.dismiss(`pass-${id}`);
    toast(`Brought back ${listingById.get(id)?.title ?? "the home"}`, { id: `unpass-${id}` });
  }, [unpass, listingById]);

  const triage = useTriage({
    enabled: !openId && !filtersSheet,
    onSave: toggleSave,
    onPass: pass,
    onOpen: openDetail,
    onUndo: undoLastPass,
  });

  const setIndexFor = useCallback((id: string, i: number) => {
    setPhotoIndex((prev) => (prev[id] === i ? prev : { ...prev, [id]: i }));
  }, []);

  const sheetOpenedAt = useRef(0);
  const toggleFilters = () => {
    if (isWide) runTransition("layout", () => setFiltersDocked((v) => !v));
    else {
      sheetOpenedAt.current = performance.now();
      setFiltersSheet(true);
    }
  };

  const resetAll = () =>
    animate(() => {
      setFilters(EMPTY_FILTERS);
      setView("all");
      setCriteria((c) => ({ university: c.university, moveIn: null, moveInFlexDays: 7, moveOut: null, moveOutFlexDays: 14, budget: null }));
    });

  /* ---------------- render ---------------- */

  const freshness = updatedAt ? `Updated ${formatRelative(updatedAt, now)}` : null;
  const resultSummary =
    view === "saved"
      ? "Private to you. Saving never contacts the advertiser."
      : view === "passed"
        ? "Homes you passed on. Restore any to bring it back."
        : main.length === 0
      ? "Nothing fits every part of your search yet."
      : `${matchCount} fit your search${confirmCount ? `, ${confirmCount} with details to confirm` : ""}`;

  return (
    <>
      <div id={APP_ROOT_ID} className="min-h-dvh">
        <div ref={sentinelRef} aria-hidden="true" className="absolute top-0 h-px w-px" />

        {/* ---------- Header + toolbar ---------- */}
        <div data-sticky-top className="hw-header sticky top-0 z-40 bg-white">
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
              <SyncControl config={sync} />
              <AlertsControl enabled={!!sync} />
              <ViewBin
                id="passed-bin"
                label="Passed"
                count={passed.size}
                bump={passedBump}
                active={view === "passed"}
                icon={<ThumbsDownIcon size={18} weight={view === "passed" ? "fill" : "regular"} />}
                onClick={() => animate(() => setView((v) => (v === "passed" ? "all" : "passed")))}
              />
              <ViewBin
                id="saved-bin"
                label="Saved"
                count={saved.size}
                bump={savedBump}
                active={view === "saved"}
                icon={<HeartIcon size={18} weight={view === "saved" || saved.size > 0 ? "fill" : "regular"} />}
                onClick={() => animate(() => setView((v) => (v === "saved" ? "all" : "saved")))}
              />
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
                {view !== "all" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => animate(() => setView("all"))}
                      className="mr-1.5 text-ink-2 underline-offset-4 hover:underline"
                    >
                      All homes
                    </button>
                    <span className="text-ink-3">/</span> {view === "saved" ? "Saved" : "Passed"}
                    <span className="tabular ml-1.5 font-normal text-ink-2">{main.length}</span>
                  </>
                ) : (
                  <>
                    <NumberFlow value={main.length} className="tabular" /> {main.length === 1 ? "home" : "homes"}
                    <span className="hidden sm:inline"> near {university.city}</span>
                  </>
                )}
              </h1>
              <p className="hidden truncate text-[13px] text-ink-2 sm:block">
                {resultSummary}
                {freshness && view === "all" ? ` · ${freshness}` : ""}
              </p>
            </div>
            <SortMenu value={sort} onChange={(s) => animate(() => setSort(s))} />
            <div className="hidden lg:block">
              <MapSwitch on={mapOn} onChange={(v) => runTransition("layout", () => setMapOn(v))} />
            </div>
          </div>
        </div>

        {/* ---------- Body ---------- */}
        <div
          className={cn(
            "flex gap-8 px-5 sm:px-6 xl:px-10",
            showDocked ? "[--map-w:33vw] 2xl:[--map-w:31vw]" : "[--map-w:40vw] 2xl:[--map-w:36vw]",
          )}
        >
          {showDocked && (
            <aside
              id={FILTERS_ID}
              aria-label="Filters"
              className="hw-filters-panel sticky top-[calc(var(--header-h)+var(--toolbar-h))] h-[calc(100dvh-var(--header-h)-var(--toolbar-h))] w-[288px] shrink-0 overflow-y-auto overscroll-contain py-6 pr-2 [scrollbar-width:thin]"
            >
              <FiltersPanel filters={filters} onChange={changeFilters} resultCount={main.length} universityName={university.short} />
            </aside>
          )}

          <main className="min-w-0 flex-1 pt-6 pb-24">
            {main.length === 0 ? (
              <EmptyState
                collecting={collecting && view === "all"}
                view={view}
                hasFilters={activeFilters > 0}
                onReset={resetAll}
                onBack={() => animate(() => setView("all"))}
              />
            ) : (
              <CardGrid
                views={mainAll}
                hiddenIds={hiddenIds}
                saved={saved}
                photoIndex={photoIndex}
                now={now}
                mode={view}
                onToggleSave={toggleSave}
                onOpen={openDetail}
                onPhotoIndex={setIndexFor}
                onRestore={unpass}
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
                  views={outsideAll}
                  hiddenIds={hiddenIds}
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
            inert={isDesktop && !mapOn}
            className={cn(
              // The map keeps a fixed width inside; only this wrapper's width changes, so hiding or
              // showing the map never resizes the WebGL canvas (no re-fit, no tile reload).
              "hw-map-panel lg:sticky lg:top-[calc(var(--header-h)+var(--toolbar-h))] lg:block lg:h-[calc(100dvh-var(--header-h)-var(--toolbar-h))] lg:shrink-0 lg:overflow-hidden lg:py-6",
              mapOn ? "lg:w-[var(--map-w)]" : "lg:-ml-8 lg:w-0",
              mobileMap
                ? "fixed inset-x-0 top-[calc(var(--header-h)+var(--toolbar-h))] bottom-0 z-30 block lg:static"
                : "hidden",
            )}
          >
            <div className="h-full overflow-hidden lg:w-[var(--map-w)] lg:rounded-[20px]">
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

        <TriageHint active={triage.active} help={triage.help} onClose={() => triage.setHelp(false)} />

        {/* Mobile map toggle */}
        <div className="hw-mobile-map-toggle pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center lg:hidden">
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
      <Dialog.Root
        open={filtersSheet && !showDocked}
        onOpenChange={(open, details) => {
          // Ignore the stray outside-press from a quick double click right after opening.
          if (!open && details?.reason === "outside-press" && performance.now() - sheetOpenedAt.current < 300) return;
          if (open) sheetOpenedAt.current = performance.now();
          setFiltersSheet(open);
        }}
      >
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
              <FiltersPanel
                filters={filters}
                onChange={(f) => setFilters(f)}
                resultCount={main.length}
                inSheet
                universityName={university.short}
              />
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
          university={campus.name}
        />
      )}

      <Toaster
        position={isMobile ? "top-center" : "bottom-right"}
        offset={24}
        mobileOffset={{ top: 156 }}
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
  hiddenIds?: ReadonlySet<string>;
  saved: ReadonlySet<string>;
  photoIndex: Record<string, number>;
  now: string;
  offset?: number;
  mode?: "all" | "saved" | "passed";
  onToggleSave: (id: string) => void;
  onOpen: (id: string) => void;
  onPhotoIndex: (id: string, i: number) => void;
  onRestore?: (id: string) => void;
}

/**
 * Plain grid: no per-card layout tracking. When results change inside a view transition, each
 * card gets a `view-transition-name` (globals.css) and the browser animates it on the compositor.
 */
const CardGrid = memo(function CardGrid({
  views,
  hiddenIds,
  saved,
  photoIndex,
  now,
  offset = 0,
  mode = "all",
  onToggleSave,
  onOpen,
  onPhotoIndex,
  onRestore,
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
            data-card-id={id}
            hidden={hiddenIds?.has(id)}
            className={cn(
              "hw-card",
              rise && "hw-rise",
            )}
            style={
              {
                "--vt-name": `card-${id}`,
                "--rise-delay": rise ? `${0.05 + Math.min(offset + i, 6) * 0.05}s` : undefined,
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
              onRestore={mode === "passed" ? onRestore : undefined}
            />
          </li>
        );
      })}
    </ul>
  );
});

function EmptyState({
  collecting,
  view,
  hasFilters,
  onReset,
  onBack,
}: {
  collecting?: boolean;
  view: "all" | "saved" | "passed";
  hasFilters: boolean;
  onReset: () => void;
  onBack: () => void;
}) {
  const copy = {
    saved: ["Nothing saved yet", "Tap the heart on a home, or press S, to keep it here. It stays private to you."],
    passed: ["Nothing passed", "Homes you mark “Not for me” land here, so you can change your mind."],
    all: [
      "No homes fit all of that",
      hasFilters ? "Try removing a filter, or widen your budget or dates." : "Try a wider budget or later dates.",
    ],
  }[view];
  if (collecting) {
    return (
      <div className="hw-swap rounded-[24px] bg-subtle px-8 py-14 text-center">
        <p className="text-[19px] font-semibold tracking-[-0.02em]">Collecting the first homes</p>
        <p className="mx-auto mt-1.5 max-w-[44ch] text-[15px] text-ink-2">
          Housewatch is reading Kamernet, HousingAnywhere, DUWO and local agents for the first time. New homes appear here
          within about 15 minutes; this page updates on its own after each pass.
        </p>
      </div>
    );
  }
  return (
    <div className="hw-swap rounded-[24px] bg-subtle px-8 py-14 text-center">
      <p className="text-[19px] font-semibold tracking-[-0.02em]">{copy[0]}</p>
      <p className="mx-auto mt-1.5 max-w-[42ch] text-[15px] text-ink-2">{copy[1]}</p>
      <button
        type="button"
        onClick={view === "all" ? onReset : onBack}
        className="press mt-6 h-11 rounded-xl px-5 text-[15px] font-semibold shadow-[inset_0_0_0_1px_var(--color-ink)]"
      >
        {view === "all" ? "Reset search and filters" : "Browse all homes"}
      </button>
    </div>
  );
}

/** A header button that is both a view toggle and the place saved/passed cards fly into. */
function ViewBin({
  id,
  label,
  count,
  bump,
  active,
  icon,
  onClick,
}: {
  id: string;
  label: string;
  count: number;
  bump: number;
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      aria-label={count ? `${label}, ${count}` : label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "press flex h-11 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold transition-colors duration-150",
        active ? "bg-ink text-white" : "hover:bg-hover",
      )}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
      {count > 0 && (
        <span
          key={bump}
          className={cn(
            "tabular grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] leading-none",
            bump > 0 && "hw-pop",
            active ? "bg-white text-ink" : "bg-ink text-white",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
