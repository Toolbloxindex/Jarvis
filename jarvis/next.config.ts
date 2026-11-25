import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  cacheComponents: true,
  partialPrefetching: true,
  images: {
    // Unsplash resizes on its own CDN; see lib/image-loader.ts.
    loader: "custom",
    loaderFile: "./lib/image-loader.ts",
    qualities: [60, 72, 85],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
