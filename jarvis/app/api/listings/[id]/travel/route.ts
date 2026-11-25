import { connection } from "next/server";
import { validListingId } from "@/core/runtime.mjs";
import { checkTravel, getTravel } from "@/lib/server/travel-repo";

type Context = { params: Promise<{ id: string }> };

async function travelResponse({ params }: Context, calculate: boolean) {
  const { id } = await params;
  if (!validListingId(id)) return Response.json({ error: "Invalid listing id." }, { status: 400 });
  try {
    const travel = calculate ? await checkTravel(id) : getTravel(id);
    if (!travel) return Response.json({ error: "Listing not found." }, { status: 404 });
    return Response.json(travel, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof Error && "status" in error ? error.status : null;
    if (status === 409 || status === 429) {
      const message = status === 409 ? "The listing location changed. Try again." : "Travel checks are busy. Try again shortly.";
      return Response.json({ error: message }, { status });
    }
    return Response.json({ error: "Travel detail is temporarily unavailable." }, { status: 500 });
  }
}

export async function GET(_request: Request, context: Context) {
  await connection();
  return travelResponse(context, false);
}

export async function POST(_request: Request, context: Context) {
  return travelResponse(context, true);
}
