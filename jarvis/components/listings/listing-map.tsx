"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import { BicycleIcon, GraduationCapIcon, HeartIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import {
  LngLatBounds,
  Map as MapLibre,
  Marker,
  setWorkerUrl,
  type LayerSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import Image from "next/image";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useIsCursor, useIsHovered } from "@/lib/hover-store";
import { formatEUR } from "@/lib/listings/format";
import { distanceKm } from "@/lib/listings/geo";
import type { ListingView } from "@/lib/listings/match";
import type { GeoPoint, Listing } from "@/lib/listings/types";
import { KIND_LABEL } from "./listing-card";

/* ------------------------------------------------------------------ */
/* Style: OpenFreeMap Positron, pushed further toward monochrome        */
/* ------------------------------------------------------------------ */

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const HIDDEN_LAYERS = /^(highway-shield|road_shield|airport|label_country|label_state|boundary|aeroway)/;

const PAINT: Record<string, Record<string, unknown>> = {
  background: { "background-color": "#f4f4f2" },
  park: { "fill-color": "#e9ece7" },
  landcover_wood: { "fill-color": "#e4e8e2" },
  landuse_residential: { "fill-color": "#f0f0ec" },
  water: { "fill-color": "#d6dbde" },
  waterway: { "line-color": "#d6dbde" },
  building: { "fill-color": "#e8e8e3" },
  water_name_point_label: { "text-color": "#8d9398" },
  water_name_line_label: { "text-color": "#8d9398" },
  label_other: { "text-color": "#9b9b9b" },
};

function monochrome(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    layers: style.layers
      .filter((layer) => !HIDDEN_LAYERS.test(layer.id))
      .map((layer) => {
        const paint = PAINT[layer.id];
        if (!paint) return layer;
        return { ...layer, paint: { ...(layer as { paint?: object }).paint, ...paint } } as LayerSpecification;
      }),
  };
}

const FIT_PADDING = { top: 72, bottom: 48, left: 48, right: 120 };

let workerConfigured = false;
function configureWorker() {
  if (workerConfigured) return;
  // The bundled chunk can't find the worker next to itself, so point at the package file.
  setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
  workerConfigured = true;
}

/* ------------------------------------------------------------------ */

interface ListingMapProps {
  listings: Listing[];
  views: ListingView[];
  campus: GeoPoint & { name: string };
  selectedId: string | null;
  openId: string | null;
  savedIds: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
}

export default function ListingMap({
  listings,
  views,
  campus,
  selectedId,
  openId,
  savedIds,
  onSelect,
  onOpen,
}: ListingMapProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const markersRef = useRef<Record<string, Marker>>({});
  const campusMarkerRef = useRef<Marker | null>(null);
  const campusRef = useRef(campus);
  const onSelectRef = useRef(onSelect);
  const onOpenRef = useRef(onOpen);
  const layoutRef = useRef<() => void>(() => {});
  const [ready, setReady] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    onSelectRef.current = onSelect;
    onOpenRef.current = onOpen;
  }, [onSelect, onOpen]);

  // One DOM node per listing for React to portal pins into. This component is client-only.
  const [nodes] = useState(() => {
    const make = () => {
      const el = document.createElement("div");
      el.className = "hw-marker";
      return el;
    };
    return {
      pins: Object.fromEntries(listings.map((l) => [l.id, make()])) as Record<string, HTMLElement>,
      campus: make(),
    };
  });

  // Create the map and markers in one effect, remove them in its cleanup. Next keeps hidden
  // pages inside <Activity>, which runs this cleanup and re-runs the effect when you return.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    configureWorker();

    const bounds = new LngLatBounds();
    for (const l of listings) bounds.extend([l.location.lng, l.location.lat]);
    const start = campusRef.current;
    // Frame the homes; include the campus only when it's in town (Rotterdam would zoom out to nothing).
    if (bounds.contains([start.lng, start.lat]) || distanceKm({ lng: bounds.getCenter().lng, lat: bounds.getCenter().lat }, start) < 6) {
      bounds.extend([start.lng, start.lat]);
    }

    const map = new MapLibre({
      container,
      style: STYLE_URL,
      center: bounds.getCenter(),
      zoom: 13,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      minZoom: 11,
      maxZoom: 17.5,
      fadeDuration: 120,
      transformStyle: (_prev, next) => monochrome(next),
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    const markers: Record<string, Marker> = {};
    for (const l of listings) {
      markers[l.id] = new Marker({ element: nodes.pins[l.id], anchor: "center" })
        .setLngLat([l.location.lng, l.location.lat])
        .addTo(map);
    }
    const campusMarker = new Marker({ element: nodes.campus, anchor: "center" })
      .setLngLat([start.lng, start.lat])
      .addTo(map);
    campusMarkerRef.current = campusMarker;
    markersRef.current = markers;

    // maplibre only learns the canvas's real size from its ResizeObserver, after `load`, so a
    // fit at construction lands far too zoomed out. Re-fit on every resize until the person
    // moves the map, and reveal the canvas once the first fitted frame has drawn.
    let userMoved = false;
    let frame = 0;
    let revealTimer = 0;
    const fit = () => {
      if (!userMoved) map.fitBounds(bounds, { padding: FIT_PADDING, duration: 0 });
    };
    const relayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => layoutRef.current());
    };
    map.on("movestart", (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) userMoved = true;
    });
    map.on("resize", () => {
      fit();
      relayout();
    });
    // Pin collisions only change with zoom, not with panning: recompute when a zoom settles.
    map.on("zoomend", relayout);
    map.once("load", () => {
      fit();
      const reveal = () => {
        window.clearTimeout(revealTimer);
        setReady(true);
        relayout();
      };
      map.once("idle", reveal);
      revealTimer = window.setTimeout(reveal, 700);
    });
    map.on("click", (e) => {
      if ((e.originalEvent.target as HTMLElement | null)?.closest(".hw-marker")) return;
      onSelectRef.current(null);
    });
    mapRef.current = map;

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(revealTimer);
      for (const m of Object.values(markers)) m.remove();
      campusMarker.remove();
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
    };
  }, [listings, nodes]);

  // Switching university moves the campus marker and glides the map to it; the map itself is
  // never rebuilt. A campus in town is framed with the homes; a far one (Rotterdam, Leiden) is
  // framed together with the homes so both stay in view.
  const firstCampus = useRef(true);
  useEffect(() => {
    campusRef.current = campus;
    campusMarkerRef.current?.setLngLat([campus.lng, campus.lat]);
    if (firstCampus.current) {
      firstCampus.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    const bounds = new LngLatBounds();
    for (const l of listings) bounds.extend([l.location.lng, l.location.lat]);
    bounds.extend([campus.lng, campus.lat]);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.fitBounds(bounds, { padding: FIT_PADDING, duration: reduce ? 0 : 900, maxZoom: 14.5, essential: false });
  }, [campus, listings]);

  // Collision pass, like Airbnb: price pills that would overlap a more important pill collapse
  // into dots. Priority: selected, open, saved, then list order. Hover never triggers it.
  useEffect(() => {
    layoutRef.current = () => {
      const map = mapRef.current;
      if (!map) return;
      const rank = (id: string, order: number) =>
        id === selectedId ? -3 : id === openId ? -2 : savedIds.has(id) ? -1 : order;
      const ordered = views.map((v, order) => ({ v, r: rank(v.listing.id, order) })).sort((a, b) => a.r - b.r);
      const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
      const next = new Set<string>();
      for (const { v } of ordered) {
        const id = v.listing.id;
        const p = map.project([v.listing.location.lng, v.listing.location.lat]);
        const w = formatEUR(v.total).length * 7.6 + 22 + (savedIds.has(id) ? 15 : 0);
        const box = { x0: p.x - w / 2 - 3, x1: p.x + w / 2 + 3, y0: p.y - 17, y1: p.y + 17 };
        const hit = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
        if (hit && id !== selectedId && id !== openId) next.add(id);
        else placed.push(box);
      }
      setCollapsed((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next));
    };
    const frame = requestAnimationFrame(() => layoutRef.current());
    return () => cancelAnimationFrame(frame);
  }, [views, selectedId, openId, savedIds]);

  // A selected pin's preview closes on Escape or on any press outside the map.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSelectRef.current(null);
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onSelectRef.current(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [selectedId]);

  // Keep the preview card inside the map when a pin near the edge is selected.
  useEffect(() => {
    const map = mapRef.current;
    const marker = selectedId ? markersRef.current[selectedId] : null;
    if (!map || !marker) return;
    const p = map.project(marker.getLngLat());
    const { clientWidth: w } = map.getContainer();
    const margin = 150;
    const dx = p.x < margin ? p.x - margin : p.x > w - margin ? p.x - (w - margin) : 0;
    const dy = p.y < 300 ? p.y - 300 : 0;
    if (dx || dy) map.panBy([dx, dy], { duration: 350, easing: (t) => 1 - Math.pow(1 - t, 3) });
  }, [selectedId]);

  const centre = useMemo(() => {
    const n = Math.max(1, listings.length);
    return {
      lat: listings.reduce((s, l) => s + l.location.lat, 0) / n,
      lng: listings.reduce((s, l) => s + l.location.lng, 0) / n,
    };
  }, [listings]);
  const campusKm = distanceKm(centre, campus);

  const viewById = useMemo(() => new Map(views.map((v, i) => [v.listing.id, { view: v, order: i }])), [views]);

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-[#f4f4f2]">
      <div
        ref={containerRef}
        className={cn("absolute inset-0 transition-opacity duration-500", ready ? "opacity-100" : "opacity-0")}
      />

      {campusKm >= 6 && (
        <div className="hw-swap absolute top-4 left-4 flex max-w-[70%] items-center gap-2 rounded-full bg-white py-1.5 pr-3.5 pl-1.5 text-[12px] shadow-[var(--shadow-pill)]">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-white">
            <GraduationCapIcon size={13} weight="fill" />
          </span>
          <span className="truncate">
            Times to <span className="font-semibold">{campus.name}</span>, {Math.round(campusKm)} km away
          </span>
        </div>
      )}

      <div className="absolute top-4 right-4 flex flex-col overflow-hidden rounded-xl bg-white shadow-[var(--shadow-pill)]">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => mapRef.current?.zoomIn({ duration: 250 })}
          className="grid size-9 place-items-center transition-colors hover:bg-hover active:bg-line-soft"
        >
          <PlusIcon size={14} weight="bold" />
        </button>
        <span className="mx-2 h-px bg-line-soft" />
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => mapRef.current?.zoomOut({ duration: 250 })}
          className="grid size-9 place-items-center transition-colors hover:bg-hover active:bg-line-soft"
        >
          <MinusIcon size={14} weight="bold" />
        </button>
      </div>

      {createPortal(
        <div className="pointer-events-none relative">
          <span className="grid size-9 place-items-center rounded-full bg-ink text-white shadow-[0_0_0_4px_rgb(255_255_255/0.85),var(--shadow-float)]">
            <GraduationCapIcon size={18} weight="fill" />
          </span>
          <span className="absolute top-1/2 left-full ml-2 -translate-y-1/2 rounded-full bg-white/95 px-2.5 py-1 text-[12px] leading-4 font-semibold whitespace-nowrap shadow-[var(--shadow-pill)]">
            {campus.name}
          </span>
        </div>,
        nodes.campus,
      )}

      {listings.map((listing) => {
        const entry = viewById.get(listing.id);
        return createPortal(
          <PricePin
            listing={listing}
            view={ready ? (entry?.view ?? null) : null}
            order={entry?.order ?? 0}
            selected={selectedId === listing.id}
            open={openId === listing.id}
            saved={savedIds.has(listing.id)}
            compact={collapsed.has(listing.id)}
            onSelectRef={onSelectRef}
            onOpenRef={onOpenRef}
          />,
          nodes.pins[listing.id],
          listing.id,
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface PricePinProps {
  listing: Listing;
  view: ListingView | null;
  order: number;
  selected: boolean;
  open: boolean;
  saved: boolean;
  compact: boolean;
  onSelectRef: React.RefObject<(id: string | null) => void>;
  onOpenRef: React.RefObject<(id: string) => void>;
}

/** Plain DOM + CSS transitions. Re-renders only when its own props or its own hover state change. */
const PricePin = memo(function PricePin({
  listing,
  view,
  order,
  selected,
  open,
  saved,
  compact,
  onSelectRef,
  onOpenRef,
}: PricePinProps) {
  const isHovered = useIsHovered(listing.id);
  const isCursor = useIsCursor(listing.id);
  const hovered = isHovered || isCursor;
  const visible = view !== null;
  const active = hovered || selected || open;
  const dot = compact && !active;
  const outside = view?.status === "outside";
  const ref = useRef<HTMLDivElement>(null);

  // Stacking: the pin you're looking at always sits on top. Markers are siblings, so the
  // z-index goes on the marker element maplibre positions (our parent).
  useEffect(() => {
    const marker = ref.current?.parentElement;
    if (marker) marker.style.zIndex = selected ? "30" : active ? "20" : saved ? "2" : "1";
  }, [selected, active, saved, visible]);

  if (!visible) return null;

  return (
    <div ref={ref} className="hw-pin relative" style={{ "--pin-delay": `${Math.min(order, 16) * 22}ms` } as React.CSSProperties}>
      <button
        type="button"
        aria-label={`${KIND_LABEL[listing.kind]} on ${listing.title}, ${formatEUR(view.total)} a month`}
        onClick={(e) => {
          e.stopPropagation();
          onSelectRef.current(selected ? null : listing.id);
        }}
        className={cn("relative grid place-items-center", dot ? "size-5" : "h-8 px-0.5")}
      >
        <span
          aria-hidden="true"
          className={cn(
            "hw-pin-face absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full",
            "shadow-[0_0_0_1.5px_rgb(255_255_255),0_1px_4px_rgb(0_0_0/0.3)]",
            outside && !saved ? "bg-ink-3" : "bg-ink",
            dot ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        />
        <span
          className={cn(
            "hw-pin-face tabular flex h-7 items-center gap-1 rounded-full px-2.5 text-[13px] font-semibold whitespace-nowrap",
            "shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_2px_6px_rgb(0_0_0/0.14)]",
            dot && "pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
            active ? "bg-ink text-white" : outside ? "bg-white text-ink-2" : "bg-white text-ink",
            dot ? "scale-75 opacity-0" : active ? "scale-[1.08] opacity-100" : "scale-100 opacity-100",
          )}
        >
          {saved && <HeartIcon size={11} weight="fill" aria-hidden="true" />}
          {formatEUR(view.total)}
        </span>
      </button>

      {selected && (
        <div className="hw-preview absolute bottom-full left-1/2 mb-2.5 w-[248px]">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenRef.current(listing.id);
            }}
            className="press block w-full overflow-hidden rounded-2xl bg-white text-left shadow-[var(--shadow-sheet)]"
          >
            <span className="relative block aspect-[3/2] bg-hover">
              <Image
                src={listing.photos[0].src}
                alt={listing.photos[0].alt}
                fill
                sizes="248px"
                quality={72}
                placeholder={listing.photos[0].blur ? "blur" : "empty"}
                blurDataURL={listing.photos[0].blur}
                className="object-cover"
              />
            </span>
            <span className="block p-3.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[14px] font-semibold">
                  {KIND_LABEL[listing.kind]} in {listing.location.neighbourhood}
                </span>
                <span className="tabular shrink-0 rounded-md bg-ink px-1.5 py-0.5 text-[12px] font-semibold text-white">
                  {view.scores.overall.value.toFixed(1)}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-1 truncate text-[13px] text-ink-2">
                {listing.title} · {listing.sizeM2} m² ·
                <BicycleIcon size={13} weight="bold" aria-hidden="true" />
                {view.travel.approximate && "≈"}
                {view.travel.bike} min
              </span>
              <span className="mt-1.5 block text-[14px]">
                <span className="tabular font-semibold">{formatEUR(view.total)}</span> month
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
});
