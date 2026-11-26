"use client";

/**
 * Listing photos arrive full size (often 2000px+, 300–900 KB) but cards show them ~250–400px wide.
 * Decoding those on scroll was the main source of stutter, so every photo is resized off-site:
 *  - Unsplash resizes on its own CDN;
 *  - everything else goes through wsrv.nl (free, open-source image CDN): exact width, WebP, and
 *    `default=` redirects to the original if the source refuses the proxy, so nothing breaks;
 *  - hosts known to block the proxy are served directly.
 * No Next.js optimizer, so no Vercel CPU or image quota is spent.
 */
const DIRECT_HOSTS = new Set(["www.roommatch.nl", "roommatch.nl"]);

export default function imageLoader({ src, width, quality }: { src: string; width: number; quality?: number }) {
  if (src.startsWith("https://images.unsplash.com/")) {
    const url = new URL(src);
    url.searchParams.set("w", String(width));
    url.searchParams.set("q", String(quality ?? 72));
    url.searchParams.set("auto", "format");
    url.searchParams.set("fit", "crop");
    return url.toString();
  }
  let host: string;
  try {
    host = new URL(src).hostname;
  } catch {
    return src; // relative or malformed: leave alone
  }
  if (DIRECT_HOSTS.has(host) || !/^https?:/.test(src)) return src;
  const q = quality ?? 72;
  return `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=${width}&q=${q}&output=webp&we&default=${encodeURIComponent(src)}`;
}
