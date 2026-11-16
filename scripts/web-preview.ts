/**
 * web-preview.ts - serve the built pages the way Vercel will: the static files in
 * apps/web/dist, every header from vercel.json (the Content-Security-Policy
 * included), and its rewrites to the public testnet REST and RPC endpoints.
 *
 *   npm run web:build && npm run web:preview      then http://localhost:4173/?net=testnet
 *
 * Only a local stand-in for checking a build before importing the repository in
 * Vercel; it holds no keys and forwards only the routes vercel.json names.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "apps", "web", "dist");
const port = Number(process.env.PORT ?? 4173);

interface VercelJson {
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
}
const vj = JSON.parse(await readFile(join(ROOT, "vercel.json"), "utf8")) as VercelJson;

/** Vercel's ":name" and ":name*" path patterns, as a regex with named groups. */
function pattern(source: string): RegExp {
  const re = source
    .replace(/[.]/g, "\\.")
    .replace(/:(\w+)\*/g, "(?<$1>.*)")
    .replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return new RegExp(`^${re}$`);
}
const rewrites = vj.rewrites.map((r) => ({ re: pattern(r.source), destination: r.destination }));
const headerRules = vj.headers.map((h) => ({ re: new RegExp(`^${h.source}$`), headers: h.headers }));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  for (const h of headerRules) if (h.re.test(url.pathname)) for (const { key, value } of h.headers) res.setHeader(key, value);
  for (const r of rewrites) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    let dest = r.destination;
    for (const [k, v] of Object.entries(m.groups ?? {})) dest = dest.replace(`:${k}*`, v).replace(`:${k}`, v);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await new Promise<Buffer>((ok) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => ok(Buffer.concat(parts)));
    });
    try {
      const up = await fetch(dest + url.search, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body });
      res.statusCode = up.status;
      res.setHeader("content-type", up.headers.get("content-type") ?? "application/json");
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      res.statusCode = 502;
      res.end(String(e));
    }
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/")) path += "index.html";
  const file = join(DIST, path);
  if (!file.startsWith(DIST)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`apps/web/dist as Vercel serves it: http://localhost:${port}/?net=testnet`));
