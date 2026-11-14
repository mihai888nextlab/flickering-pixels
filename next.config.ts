import type { NextConfig } from "next";

const SPHEREX_API = process.env.SPHEREX_API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      {
        source: "/spherex-api/:path*",
        destination: `${SPHEREX_API}/:path*`,
      },
      // Same-origin HiPS proxy — CDS alasky is often unreachable; IRSA mirrors 2MASS/AllWISE
      // but without CORS, so Aladin WebGL cannot load tiles cross-origin.
      {
        source: "/hips/:path*",
        destination: "https://irsa.ipac.caltech.edu/data/hips/:path*",
      },
    ];
  },
};

export default nextConfig;
