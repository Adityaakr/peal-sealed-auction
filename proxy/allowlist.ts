/**
 * The read-only REST routes the apps need, and nothing else. The public REST
 * endpoint sends no CORS headers, so browsers reach it through this proxy.
 * The proxy is untrusted by design: every key it returns is checked against a
 * hash the key's owner signed on chain (see client/committee.ts).
 */
export const ALLOWED_GET = [
  /^\/qorechain\/pqc\/v1\/kem\/[a-z0-9]+$/,
  /^\/qorechain\/pqc\/v1\/account\/[a-z0-9]+$/,
  /^\/qorechain\/pqc\/v1\/params$/,
  // Transaction search: smart-account bids (MsgExecuteEVM) carry their envelopes only in calldata.
  /^\/cosmos\/tx\/v1beta1\/txs$/,
];

export function allowed(method: string, path: string): boolean {
  return method === "GET" && ALLOWED_GET.some((r) => r.test(path));
}
