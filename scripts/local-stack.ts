/**
 * local-stack.ts - a long-running local chain for the web pages.
 *
 *   npm run local:stack        then, in another terminal: npm run web
 *
 * Starts the stack from scripts/local/stack.ts (anvil, precompile stand-ins,
 * contracts, a 2-of-3 committee with real ML-DSA-87 and QoreSeal keys), opens
 * one auction, gives the three bidders fUSD, and writes
 * apps/web/public/config.local.json for the pages. That file holds throwaway
 * local mnemonics; it is gitignored. Stop with Ctrl-C.
 */
import { parseUnits } from "viem";
import { startStack, writeLocalWebConfig } from "./local/stack.ts";

const s = await startStack({ port: Number(process.env.ANVIL_PORT ?? 18545), restPort: Number(process.env.REST_PORT ?? 18546) });
const auction = await s.createAuction({ name: "Local demo", details: "PEAL-T for fUSD" });
for (const b of s.bidders) await s.mintFusd(b.address, parseUnits("1000", 6));

const path = writeLocalWebConfig(s, auction);
console.log(`auction  ${auction}\nwrote ${path}\nlocal stack running; Ctrl-C to stop`);
const stop = () => {
  s.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
