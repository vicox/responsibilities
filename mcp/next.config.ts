import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const NO_STORE = [{ key: "cache-control", value: "private, no-store, max-age=0, must-revalidate" }];

/**
 * The repository root, not this directory: the app bundles the sources of
 * responsibilities-core from `../src` (`lib/core.ts`, the only import of them),
 * and Turbopack resolves and traces no file outside its root. Set explicitly so
 * Next.js does not guess a root from whichever lockfile it finds first. On
 * Vercel (Root Directory `mcp`) this needs "Include source files outside of the
 * Root Directory" enabled.
 */
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

const nextConfig: NextConfig = {
  turbopack: { root: REPOSITORY_ROOT },
  outputFileTracingRoot: REPOSITORY_ROOT,

  /**
   * PGlite (embedded Postgres, development and tests only) stays out of the
   * server bundle and out of traced deployment files: production sets
   * DATABASE_URL and `lib/db.ts` refuses to fall back, so that import is
   * unreachable there (ported from Tonight).
   */
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingExcludes: {
    "/**": ["./node_modules/@electric-sql/pglite/**"],
  },

  /** Nothing on the MCP or OAuth surface may sit in a shared cache. */
  async headers() {
    return [
      { source: "/mcp", headers: NO_STORE },
      { source: "/oauth/:path*", headers: NO_STORE },
    ];
  },
};

export default nextConfig;
