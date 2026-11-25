import { createHash, timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function POST(request: Request) {
  const token = process.env.HOUSEWATCH_REVALIDATE_TOKEN;
  if (!token) return Response.json({ error: "Revalidation is disabled." }, { status: 503 });
  const authorization = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(authorization), digest(`Bearer ${token}`))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  revalidateTag("listings", { expire: 0 });
  return Response.json({ revalidated: true });
}
