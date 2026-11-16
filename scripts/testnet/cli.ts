/**
 * cli.ts - testnet operations for Peal Sealed Auction (qorechain-diana).
 *
 *   npm run testnet -- accounts create|status
 *   npm run testnet -- setup                   fund, register ML-DSA and ML-KEM keys
 *   npm run testnet -- deploy                  deploy, register the committee, write configs
 *   npm run testnet -- demo                    one whole sealed auction with the real precompiles
 *   npm run testnet -- create                  only open an auction (default 15 min bidding, 15 min releases)
 *   npm run testnet -- settle <auction>        wait for the close, 2 releases, open, finalize
 *   npm run testnet -- window <name> <auction> open the scoped window an account needs for the web pages
 *   npm run testnet -- close <auction>         close an auction nobody bid on and return its supply
 */
export {};

const [group, cmd] = process.argv.slice(2);
if (group === "accounts") {
  const a = await import("./accounts.ts");
  if (cmd === "create") await a.create();
  else if (cmd === "status") await a.status();
  else throw new Error("accounts create|status");
} else if (group === "setup") {
  await (await import("./setup.ts")).setup();
} else if (group === "deploy") {
  await (await import("./deploy.ts")).deploy();
} else if (group === "create") {
  await (await import("./demo.ts")).create(process.argv.slice(3));
} else if (group === "settle") {
  await (await import("./demo.ts")).settle(cmd as `0x${string}`);
} else if (group === "window") {
  await (await import("./demo.ts")).windowFor(cmd!, process.argv[4] as `0x${string}`);
} else if (group === "close") {
  await (await import("./demo.ts")).closeEmpty(cmd as `0x${string}`);
} else if (group === "demo") {
  await (await import("./demo.ts")).demo(process.argv.slice(3));
} else {
  console.error("usage: npm run testnet -- accounts create|status | setup | deploy | demo | create | window <name> <auction> | close <auction>");
  process.exit(2);
}
