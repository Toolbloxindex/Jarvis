import { STUDENT_CITIES } from "@/lib/universities";
import { getRegionPage, regionId } from "@/lib/server/listings-repo";

/**
 * The homes around one student city (see getRegionPage). Every region is prerendered and cached
 * under the `listings` tag, so serving it costs no function time until the collector's
 * /api/revalidate marks it stale; then the next visit regenerates it once.
 */
export function generateStaticParams() {
  return STUDENT_CITIES.map(({ id }) => ({ region: id }));
}

const known = new Set<string>(STUDENT_CITIES.map(({ id }) => id));

async function regionPage(region: string) {
  "use cache";
  return getRegionPage(regionId(region));
}

export async function GET(_request: Request, { params }: RouteContext<"/api/feed/[region]">) {
  const { region } = await params;
  if (!known.has(region)) return Response.json({ error: "Unknown region" }, { status: 404 });
  return Response.json(await regionPage(region));
}
