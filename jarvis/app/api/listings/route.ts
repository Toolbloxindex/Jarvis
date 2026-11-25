import { getListings } from "@/lib/server/listings-repo";

export async function GET() {
  return Response.json(await getListings());
}
