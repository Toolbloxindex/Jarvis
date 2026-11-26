import type { Metadata } from "next";
import { ListingsExperience } from "@/components/listings/listings-experience";
import { DEFAULT_SEARCH } from "@/lib/listings/defaults";
import { getLivePage } from "@/lib/server/listings-repo";

export const metadata: Metadata = {
  title: "Homes in Delft · Housewatch",
  description: "Rooms, studios and apartments in Delft from every source, checked against your search.",
};

/** Public values only (project URL + anon key); the database functions enforce access. */
function syncConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export default async function ListingsPage() {
  const page = await getLivePage();
  return (
    <ListingsExperience
      listings={page.listings}
      now={page.now}
      updatedAt={page.updatedAt}
      collecting={page.collecting}
      initialSearch={DEFAULT_SEARCH}
      sync={syncConfig()}
    />
  );
}
