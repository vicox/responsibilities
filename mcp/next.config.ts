import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const NO_STORE = [{ key: "cache-control", value: "private, no-store, max-age=0, must-revalidate" }];

/**
 * This directory, not the repository root: the app lives in `mcp/` beside another
 * package with its own lockfile, and Next.js would otherwise take the outermost
 * lockfile's directory as the workspace root for bundling and file tracing.
 */
const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  turbopack: { root: APP_ROOT },
  outputFileTracingRoot: APP_ROOT,

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
