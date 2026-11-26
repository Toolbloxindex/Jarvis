import type { Metadata } from "next";
import { RegionFeed } from "@/components/listings/region-feed";
import { DEFAULT_SEARCH } from "@/lib/listings/defaults";
import { DEFAULT_REGION, getRegionPage } from "@/lib/server/listings-repo";

export const metadata: Metadata = {
  title: "Student homes in the Netherlands · Housewatch",
  description:
    "Rooms, studios and apartments near every Dutch university, from every source, checked against your search.",
};

/** Public values only (project URL + anon key); the database functions enforce access. */
function syncConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export default async function ListingsPage() {
  // The default region is server-rendered; other regions load on the client (cached API).
  const page = await getRegionPage(DEFAULT_REGION);
  return <RegionFeed initial={page} initialSearch={DEFAULT_SEARCH} sync={syncConfig()} />;
}
