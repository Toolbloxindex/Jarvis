import type { MetadataRoute } from "next";

/** Installable app (Add to Home Screen): needed for web push on iPhone and iPad. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Housewatch",
    short_name: "Housewatch",
    description: "Student rentals from every source, checked against your search.",
    id: "/listings",
    start_url: "/listings",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
