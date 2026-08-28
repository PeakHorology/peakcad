import type { NextConfig } from "next";

const isStaticExport = process.env.STATIC_EXPORT === "true";
const extraAllowedDevOrigins = (process.env.SKETCHFORGE_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  devIndicators: false,
  // Keep the live development compiler isolated from `next build`. Sharing
  // `.next` lets a production verification build invalidate chunks used by a
  // running dev server, which also breaks API routes such as project snapshots.
  distDir: isStaticExport ? ".next-export" : process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  allowedDevOrigins: ["localhost", "127.0.0.1", ...extraAllowedDevOrigins],
  env: {
    NEXT_PUBLIC_STATIC_EXPORT: isStaticExport ? "true" : "false",
  },
  images: {
    unoptimized: true
  },
  // brepjs (loaded lazily by the STEP exporter) ships an auto-init helper that
  // tries optional kernel backends via guarded `import().catch()`. We only install
  // and use occt-wasm, so silence the resolution warnings for the backends we omit.
  webpack: (config, { isServer, webpack }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "brepkit-wasm": false,
      "brepjs-opencascade": false,
    };
    // Next.js worker chunks finish with `_N_E = __webpack_exports__`, but Workers
    // never get the main-thread `_N_E` declaration. That throws ReferenceError on
    // startup and surfaces as "The CAD worker could not start."
    if (!isServer) {
      config.plugins.push(
        new webpack.BannerPlugin({
          raw: true,
          entryOnly: false,
          test: /workers_.*_worker_|[\\/]workers[\\/].*\.worker\./,
          banner:
            "var _N_E = (typeof self !== 'undefined' && self._N_E) ? self._N_E : {};" +
            "if (typeof self !== 'undefined') self._N_E = _N_E;",
        }),
      );
    }
    return config;
  },
  ...(isStaticExport
    ? {
        output: "export" as const,
        trailingSlash: true,
      }
    : {
        // Dev/server only — static export cannot set headers; Electron serves COOP/COEP itself.
        async headers() {
          return [
            {
              source: "/:path*",
              headers: [
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
