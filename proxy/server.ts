/**
 * server.ts - a tiny read-only REST proxy for the PQC routes, with CORS.
 *
 *   npm run proxy                      (listens on 127.0.0.1:8787)
 *   QORE_REST_URL=... PORT=... npm run proxy
 *
 * GET only, allowlisted paths only, no cookies, no request bodies forwarded.
 */
import { createServer } from "node:http";
import { allowed } from "./allowlist.ts";

const upstream = (process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host").replace(/\/+$/, "");
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET");
  if (req.method === "OPTIONS") return res.end();
  const path = (req.url ?? "/").split("?")[0]!;
  if (!allowed(req.method ?? "", path)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: "not an allowed route" }));
  }
  try {
    const r = await fetch(`${upstream}${path}`, { headers: { accept: "application/json" } });
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(await r.text());
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(err) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`PQC REST proxy on http://127.0.0.1:${port} -> ${upstream}`));
