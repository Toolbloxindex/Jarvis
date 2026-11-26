import { storeKind } from "../../../core/open-store.mjs";
import { getListings } from "@/lib/server/listings-repo";

export async function GET() {
  const feed = await getListings();
  // Production never serves the demo homes: before the first collection the feed is empty.
  if (storeKind() === "supabase" && feed.source !== "live") {
    return Response.json({ listings: [], source: "live", updatedAt: feed.updatedAt, collecting: true });
  }
  return Response.json(feed);
}
