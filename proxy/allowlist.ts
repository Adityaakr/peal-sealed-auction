/**
 * The read-only REST routes the apps need, and nothing else. The public REST
 * endpoint sends no CORS headers, so browsers reach it through this proxy
 * (locally: proxy/server.ts or the Vite dev server; hosted: the matching
 * rewrites in vercel.json, which name the same routes).
 * The proxy is untrusted by design: every key it returns is checked against a
 * hash the key's owner signed on chain (see client/committee.ts).
 */
export const ALLOWED_GET = [
  /^\/qorechain\/pqc\/v1\/kem\/[a-z0-9]+$/,
  /^\/qorechain\/pqc\/v1\/account\/[a-z0-9]+$/,
  /^\/qorechain\/pqc\/v1\/params$/,
  // Transaction search: smart-account bids (MsgExecuteEVM) carry their envelopes only in calldata.
  /^\/cosmos\/tx\/v1beta1\/txs$/,
  // The browser guest account: its balance, account number and sequence, and its EVM window.
  /^\/cosmos\/bank\/v1beta1\/balances\/[a-z0-9]+$/,
  /^\/cosmos\/auth\/v1beta1\/accounts\/[a-z0-9]+$/,
  /^\/qorechain\/pqc\/v1\/evm_window\/[a-z0-9]+$/,
  // The AMM's pools: a guest short of fUSD for a sale buys it with QOR (client/amm.ts).
  /^\/qorechain\/amm\/v1\/pools$/,
];

export function allowed(method: string, path: string): boolean {
  return method === "GET" && ALLOWED_GET.some((r) => r.test(path));
}
