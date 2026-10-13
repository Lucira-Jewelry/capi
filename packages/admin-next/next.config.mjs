import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

const COLLECTOR = process.env.COLLECTOR_URL ?? 'http://localhost:8787';

/**
 * Production is a static export, served by the collector itself at /admin: same address as the API, so no CORS and
 * no second service. `next dev` cannot do a static export together with rewrites, so while developing the API is
 * passed on to a running collector (set COLLECTOR_URL if it is not on 8787).
 */
export default (phase) =>
  phase === PHASE_DEVELOPMENT_SERVER
    ? {
        basePath: '/admin',
        trailingSlash: true,
        // Without this, /admin/api/me is redirected to /admin/api/me/ before it can be passed on.
        skipTrailingSlashRedirect: true,
        agentRules: false,
        images: { unoptimized: true },
        async rewrites() {
          return [{ source: '/admin/api/:path*', destination: `${COLLECTOR}/admin/api/:path*`, basePath: false }];
        },
      }
    : {
        output: 'export',
        basePath: '/admin',
        trailingSlash: true,
        images: { unoptimized: true },
      };
