"use client";

import { useEffect, useState } from "react";
import type { Listing, SearchCriteria } from "@/lib/listings/types";
import { usePersisted } from "@/lib/persist";
import { universityById } from "@/lib/universities";
import type { SyncConfig } from "@/lib/sync";
import { ListingsExperience } from "./listings-experience";

export interface RegionFeedPage {
  region: string;
  listings: Listing[];
  now: string;
  updatedAt: string | null;
  collecting: boolean;
}

/**
 * Loads the homes around the chosen university. The server renders the default region; when the
 * search's university belongs to another student city, that region's feed is fetched once (a
 * cached, prerendered response) and kept for the session. The search itself lives in the same
 * persisted store ListingsExperience uses, so this only reads it.
 */
export function RegionFeed({
  initial,
  initialSearch,
  sync,
}: {
  initial: RegionFeedPage;
  initialSearch: SearchCriteria;
  sync: SyncConfig | null;
}) {
  const [search] = usePersisted<SearchCriteria>("search", initialSearch);
  const region = universityById(search.university).region;
  const [pages, setPages] = useState<Record<string, RegionFeedPage>>(() => ({ [initial.region]: initial }));

  useEffect(() => {
    if (pages[region]) return;
    const controller = new AbortController();
    fetch(`/api/feed/${encodeURIComponent(region)}`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<RegionFeedPage>) : null))
      .then((page) => {
        if (page) setPages((previous) => ({ ...previous, [region]: page }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [region, pages]);

  // Until a newly chosen region arrives, keep showing the previous one (the map is already flying).
  const page = pages[region] ?? pages[initial.region];
  // A new region is a new result set: remount rather than swap every home (and map pin) in place.
  // Personal state (saved, passed, search, filters) is persisted, so nothing is lost.
  return (
    <ListingsExperience
      key={page.region}
      listings={page.listings}
      now={page.now}
      updatedAt={page.updatedAt}
      collecting={page.collecting}
      initialSearch={initialSearch}
      sync={sync}
    />
  );
}
