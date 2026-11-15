import { resolve } from "node:path";
import { defineConfig } from "vite";
import { allowed } from "../../proxy/allowlist.ts";

const rest = process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host";
const evm = process.env.QORE_EVM_RPC_URL?.trim() || "https://evm-testnet.qore.host";

export default defineConfig({
  root: import.meta.dirname,
  build: {
    target: "es2022",
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        bidder: resolve(import.meta.dirname, "bidder.html"),
        committee: resolve(import.meta.dirname, "committee.html"),
        results: resolve(import.meta.dirname, "results.html"),
      },
    },
  },
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  server: {
    proxy: {
      // Read-only PQC REST routes (the public endpoint sends no CORS headers).
      "/rest": {
        target: rest,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rest/, ""),
        bypass: (req) => (allowed(req.method ?? "", (req.url ?? "").replace(/^\/rest/, "").split("?")[0]!) ? undefined : false),
      },
      "/evm": { target: evm, changeOrigin: true, rewrite: () => "/" },
    },
  },
});
