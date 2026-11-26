/**
 * Stores this browser's sync key in a first-party cookie set by the server. Safari caps cookies
 * and storage written by scripts at 7 days of inactivity; a server-set cookie lasts its full
 * lifetime (browsers cap it at 400 days). Called once per device and after pairing.
 */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const key = body && typeof body === "object" && "key" in body ? (body as { key: unknown }).key : null;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
    return new Response(null, { status: 400 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": `hw_sync=${key}; Max-Age=34560000; Path=/; SameSite=Lax; Secure`,
      "Cache-Control": "no-store",
    },
  });
}
