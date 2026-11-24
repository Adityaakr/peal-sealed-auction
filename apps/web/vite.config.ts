import { resolve } from "node:path";
import { defineConfig } from "vite";
import { allowed } from "../../proxy/allowlist.ts";

const rest = process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host";
const evm = process.env.QORE_EVM_RPC_URL?.trim() || "https://evm-testnet.qore.host";
const comet = process.env.QORE_COMET_RPC_URL?.trim() || "https://rpc-testnet.qore.host";

const PAGES = ["index", "auctions", "issuer", "bidder", "committee", "results", "judge"];

/**
 * The REST API and the CometBFT RPC send no CORS headers, so the pages reach them
 * through same-origin paths: this dev server forwards them locally, and the
 * rewrites in vercel.json do the same when hosted. Both forward only to the
 * public testnet endpoints and hold no keys.
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    {
      // /judge is judge.html, as the rewrite in vercel.json makes it when hosted.
      name: "judge-route",
      configureServer: (server) => {
        server.middlewares.use((req, _res, next) => {
          if (req.url && /^\/judge\/?(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/judge\/?/, "/judge.html");
          next();
        });
      },
    },
  ],
  build: {
    target: "es2022",
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  server: {
    proxy: {
      // Read-only REST routes (see proxy/allowlist.ts).
      "/rest": {
        target: rest,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rest/, ""),
        bypass: (req) => (allowed(req.method ?? "", (req.url ?? "").replace(/^\/rest/, "").split("?")[0]!) ? undefined : false),
      },
      // CometBFT JSON-RPC: the guest account broadcasts its hybrid-signed native messages here.
      "/rpc": { target: comet, changeOrigin: true, rewrite: (p) => p.replace(/^\/rpc/, "") || "/" },
      "/evm": { target: evm, changeOrigin: true, rewrite: () => "/" },
    },
  },
});
