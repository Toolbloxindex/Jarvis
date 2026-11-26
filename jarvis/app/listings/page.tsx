import type { Metadata } from "next";
import { ListingsExperience } from "@/components/listings/listings-experience";
import { DEFAULT_SEARCH, MOCK_NOW } from "@/lib/listings/data";
import { getUiFeed } from "@/lib/server/listings-repo";

export const metadata: Metadata = {
  title: "Homes in Delft · Housewatch",
  description: "Rooms, studios and apartments in Delft from every source, checked against your search.",
};

export default async function ListingsPage() {
  const { listings } = await getUiFeed(MOCK_NOW);
  return (
    <ListingsExperience
      listings={listings}
      now={MOCK_NOW}
      initialSearch={DEFAULT_SEARCH}
    />
  );
}
