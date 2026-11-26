import { STUDENT_CITIES } from "@/lib/universities";
import { getRegionPage, regionId } from "@/lib/server/listings-repo";

/**
 * The homes around one student city (see getRegionPage). Every region is prerendered and cached
 * under the `listings` tag, so serving it costs no function time until the collector's
 * /api/revalidate marks it stale; then the next visit regenerates it once.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return STUDENT_CITIES.map(({ id }) => ({ region: id }));
}

async function regionPage(region: Promise<string>) {
  "use cache";
  return getRegionPage(regionId(await region));
}

export async function GET(_request: Request, { params }: RouteContext<"/api/feed/[region]">) {
  return Response.json(await regionPage(params.then((p) => p.region)));
}
