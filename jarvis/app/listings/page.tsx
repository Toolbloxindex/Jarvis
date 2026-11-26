import type { Metadata } from "next";
import { ListingsExperience } from "@/components/listings/listings-experience";
import { DEFAULT_SEARCH } from "@/lib/listings/defaults";
import { getLivePage } from "@/lib/server/listings-repo";

export const metadata: Metadata = {
  title: "Homes in Delft · Housewatch",
  description: "Rooms, studios and apartments in Delft from every source, checked against your search.",
};

export default async function ListingsPage() {
  const page = await getLivePage();
  return (
    <ListingsExperience
      listings={page.listings}
      now={page.now}
      updatedAt={page.updatedAt}
      collecting={page.collecting}
      initialSearch={DEFAULT_SEARCH}
    />
  );
}
