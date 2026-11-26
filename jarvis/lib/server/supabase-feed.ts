import "server-only";
import { createClient } from "@supabase/supabase-js";
import { travelDisplay } from "../../core/travel.mjs";
import { mapStoredListings, type Change, type StoredListing } from "./listings-data.ts";
import { catalogRows } from "./to-ui-listing.ts";

type PublicRow = {
  id: string;
  data: StoredListing;
  history: Change[];
  travel: Parameters<typeof travelDisplay>[1];
};

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_ANON_KEY are required for Supabase reads.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export function publicTravelDisplay(row: PublicRow) {
  return travelDisplay(row.data, row.travel, { transitEnabled: !!row.travel?.result?.transitEnabled });
}

export async function readSupabaseListings() {
  const client = anonClient();
  const status = await client.from("public_feed_status").select("finished_at").single();
  if (status.error) throw new Error("Could not read public collector freshness.");
  const batchSize = 200;
  const rows: PublicRow[] = [];
  for (let offset = 0; ; offset += batchSize) {
    const result = await client.from("public_listings").select("id,data,travel,history")
      .order("id").range(offset, offset + batchSize - 1).returns<PublicRow[]>();
    if (result.error) throw new Error("Could not read public listings from Supabase.");
    rows.push(...result.data);
    if (result.data.length < batchSize) break;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const updatedAt = status.data.finished_at ? new Date(status.data.finished_at).toISOString() : null;
  const listings = rows.map((row) => row.data).sort((a, b) => b.created_at.localeCompare(a.created_at));
  return mapStoredListings(listings, rows.flatMap((row) => row.history), (listing) => {
    const row = byId.get(listing.id)!;
    return publicTravelDisplay({ ...row, data: listing });
  }, updatedAt);
}

export async function readSupabaseListingTravel(id: string) {
  const result = await anonClient().from("public_listings").select("id,data,travel").eq("id", id).maybeSingle()
    .returns<Omit<PublicRow, "history"> | null>();
  if (result.error) throw new Error("Could not read cached listing travel from Supabase.");
  return result.data ? publicTravelDisplay({ ...result.data, history: [] }) : null;
}

export async function hasSupabaseListings() {
  const result = await anonClient().from("public_listings").select("id").limit(1);
  if (result.error) throw new Error("Could not read public listings from Supabase.");
  return result.data.length > 0;
}

export async function readSupabaseAmenities() {
  const result = await anonClient().from("public_amenities").select("catalog,name,kind,lat,lon");
  if (result.error) throw new Error("Could not read public amenities from Supabase.");
  const local = catalogRows(result.data.filter((row) => row.catalog === "travel.catalog.local"));
  const localKinds = new Set(local.map((place) => place.kind));
  const shared = catalogRows(result.data.filter((row) => row.catalog === "travel.catalog.v1"));
  return [...local, ...shared.filter((place) => !localKinds.has(place.kind))];
}
