"use client";

import { BicycleIcon, CaretLeftIcon, CaretRightIcon, HeartIcon } from "@phosphor-icons/react";
import useEmblaCarousel from "embla-carousel-react";
import Image from "next/image";
import { memo, useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { hoverStore } from "@/lib/hover-store";
import { formatDay, formatEUR, formatMonths, isAvailableNow } from "@/lib/listings/format";
import { outsideReason, type ListingView } from "@/lib/listings/match";
import type { Listing } from "@/lib/listings/types";

export const KIND_LABEL: Record<Listing["kind"], string> = {
  room: "Room",
  studio: "Studio",
  apartment: "Apartment",
};

export function availabilityLabel(listing: Listing, now: string) {
  const from = listing.tenancy.availableFrom;
  return isAvailableNow(from, now) ? "Available now" : `From ${formatDay(from, now)}`;
}

export function termLabel(listing: Listing) {
  const { minMonths, maxMonths } = listing.tenancy;
  if (maxMonths === "indefinite") return minMonths ? `min. ${formatMonths(minMonths)}` : "open-ended";
  if (typeof maxMonths === "number") return `up to ${formatMonths(maxMonths)}`;
  if (minMonths) return `min. ${formatMonths(minMonths)}`;
  return "term not stated";
}

export function billsLabel(view: ListingView) {
  if (view.listing.costs.billsIncluded) return "bills incl.";
  return view.totalComplete ? "est. bills incl." : "excl. utilities";
}

function badgeFor(view: ListingView, now: string): string | null {
  if (view.status === "outside") {
    const reason = outsideReason(view);
    if (!reason) return null;
    if (reason.key === "moveIn") return availabilityLabel(view.listing, now);
    return reason.label;
  }
  if (view.priceDropped) return "Price dropped";
  if (view.isNew) return "Just listed";
  if (view.toConfirm > 0) return `${view.toConfirm} to confirm`;
  return null;
}

/** Score badge: a small ink chip, the one place Airbnb shows its rating. */
export function ScoreChip({ value, className }: { value: number; className?: string }) {
  return (
    <span
      title="Overall score out of 10"
      className={cn(
        "tabular inline-flex h-[22px] min-w-[30px] items-center justify-center rounded-md bg-ink px-1.5 text-[12px] font-semibold text-white",
        className,
      )}
    >
      {value.toFixed(1)}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export function SaveHeart({ saved, size = 24 }: { saved: boolean; size?: number }) {
  return (
    <span className={cn("relative block", saved && "hw-pop")} style={{ width: size, height: size }}>
      <HeartIcon
        size={size}
        weight="fill"
        className={cn("absolute inset-0 transition-colors duration-150", saved ? "text-ink" : "text-black/45")}
      />
      <HeartIcon size={size} weight="bold" className="absolute inset-0 text-white" />
    </span>
  );
}

/* ------------------------------------------------------------------ */

interface PhotoFrameProps {
  listing: Listing;
  index: number;
  onIndexChange: (i: number) => void;
  onOpen: () => void;
  priority: boolean;
}

/** The photo frame is also the element that morphs into the detail hero (see lib/view-transition). */
function PhotoFrame({ listing, index, onIndexChange, onOpen, priority }: PhotoFrameProps) {
  const [emblaRef, embla] = useEmblaCarousel({ duration: 22, startIndex: index });
  const [visited, setVisited] = useState(() => new Set([index, index + 1]));
  const photos = listing.photos;

  useEffect(() => {
    if (!embla) return;
    const onSelect = () => {
      const i = embla.selectedScrollSnap();
      setVisited((prev) => (prev.has(i) && prev.has(i + 1) ? prev : new Set([...prev, i, i + 1])));
      onIndexChange(i);
    };
    embla.on("select", onSelect);
    return () => {
      embla.off("select", onSelect);
    };
  }, [embla, onIndexChange]);

  // Follow index changes made elsewhere (e.g. browsing photos in the detail view).
  useEffect(() => {
    if (embla && embla.selectedScrollSnap() !== index) embla.scrollTo(index, true);
  }, [embla, index]);

  const go = useCallback(
    (dir: -1 | 1) => (e: React.MouseEvent) => {
      e.stopPropagation();
      if (dir === 1) embla?.scrollNext();
      else embla?.scrollPrev();
    },
    [embla],
  );

  const dots = Math.min(photos.length, 5);
  const dotIndex = Math.min(index, dots - 1);

  return (
    <div data-photo={listing.id} className="relative aspect-[20/19] overflow-hidden rounded-2xl bg-hover">
      <div ref={emblaRef} className="h-full cursor-pointer overflow-hidden" onClick={onOpen}>
        <div className="flex h-full touch-pan-y">
          {photos.map((photo, i) => (
            <div key={photo.src} className="relative h-full min-w-0 flex-[0_0_100%]">
              {visited.has(i) && (
                <Image
                  src={photo.src}
                  alt={photo.alt}
                  fill
                  draggable={false}
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 380px"
                  quality={72}
                  preload={priority && i === 0}
                  placeholder={photo.blur ? "blur" : "empty"}
                  blurDataURL={photo.blur}
                  className="object-cover select-none"
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Arrows only for precise pointers; touch users swipe. */}
      <div className="pointer-events-none absolute inset-x-3 top-1/2 hidden -translate-y-1/2 justify-between [@media(hover:hover)_and_(pointer:fine)]:flex">
        {(
          [
            [-1, CaretLeftIcon, "Previous photo", index > 0],
            [1, CaretRightIcon, "Next photo", index < photos.length - 1],
          ] as const
        ).map(([dir, Icon, label, enabled]) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            tabIndex={-1}
            onClick={go(dir)}
            className={cn(
              "press grid size-8 place-items-center rounded-full bg-white/90 shadow-[var(--shadow-pill)] transition-opacity duration-150 hover:bg-white",
              enabled ? "pointer-events-auto opacity-0 group-hover:opacity-100" : "invisible",
            )}
          >
            <Icon size={12} weight="bold" />
          </button>
        ))}
      </div>

      {dots > 1 && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-[5px]">
          {Array.from({ length: dots }, (_, i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-full bg-white transition-[opacity,scale] duration-200",
                i === dotIndex ? "opacity-100" : "scale-[0.8] opacity-60",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export interface ListingCardProps {
  view: ListingView;
  now: string;
  saved: boolean;
  photoIndex: number;
  priority: boolean;
  onToggleSave: (id: string) => void;
  onOpen: (id: string) => void;
  onPhotoIndex: (id: string, i: number) => void;
}

export const ListingCard = memo(function ListingCard({
  view,
  now,
  saved,
  photoIndex,
  priority,
  onToggleSave,
  onOpen,
  onPhotoIndex,
}: ListingCardProps) {
  const { listing, travel } = view;
  const badge = badgeFor(view, now);
  const open = useCallback(() => onOpen(listing.id), [onOpen, listing.id]);
  const setIndex = useCallback((i: number) => onPhotoIndex(listing.id, i), [onPhotoIndex, listing.id]);
  const outside = view.status === "outside";

  return (
    <article
      className="group relative"
      onPointerEnter={(e) => e.pointerType === "mouse" && hoverStore.set(listing.id)}
      onPointerLeave={(e) => e.pointerType === "mouse" && hoverStore.set(null)}
    >
      <PhotoFrame listing={listing} index={photoIndex} onIndexChange={setIndex} onOpen={open} priority={priority} />

      {badge && (
        <span
          className={cn(
            "pointer-events-none absolute top-3 left-3 rounded-full px-2.5 py-1 text-[12px] leading-4 font-semibold shadow-[var(--shadow-pill)]",
            outside ? "bg-ink text-white" : "bg-white text-ink",
          )}
        >
          {badge}
        </span>
      )}

      <button
        type="button"
        aria-pressed={saved}
        aria-label={saved ? `Remove ${listing.title} from shortlist` : `Save ${listing.title} to shortlist`}
        onClick={() => onToggleSave(listing.id)}
        className="press absolute top-2 right-2 grid size-10 place-items-center rounded-full"
      >
        <SaveHeart saved={saved} />
      </button>

      <div className="relative mt-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate text-[15px] leading-5 font-semibold">
            <button
              type="button"
              onClick={open}
              className="text-left outline-offset-4 after:absolute after:inset-0 after:content-['']"
            >
              {KIND_LABEL[listing.kind]} in {listing.location.neighbourhood}
            </button>
          </h3>
          <ScoreChip value={view.scores.overall.value} className="shrink-0" />
        </div>
        <p className="flex min-w-0 items-center gap-1 text-[14px] leading-5 text-ink-2">
          <span className="truncate">
            {listing.title} · {listing.sizeM2} m² ·
          </span>
          <BicycleIcon size={14} weight="bold" className="shrink-0" aria-label="by bike to campus" />
          <span className="tabular shrink-0">
            {travel.approximate && "≈"}
            {travel.bike} min
          </span>
        </p>
        <p className="truncate text-[14px] leading-5 text-ink-2">
          {availabilityLabel(listing, now)} · {termLabel(listing)}
        </p>
        <p className="mt-1.5 text-[15px] leading-5">
          {view.priceDropped && listing.costs.previousRent && (
            <s className="tabular mr-1.5 text-ink-2">
              {formatEUR(view.total + (listing.costs.previousRent - listing.costs.rent))}
            </s>
          )}
          <span className="tabular font-semibold">{formatEUR(view.total)}</span> month
          <span className="text-ink-2"> · {billsLabel(view)}</span>
        </p>
      </div>
    </article>
  );
});
