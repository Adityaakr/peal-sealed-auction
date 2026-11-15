/**
 * cli.ts - testnet operations for Peal Sealed Auction (qorechain-diana).
 *
 *   npm run testnet -- accounts create|status
 *   npm run testnet -- setup                   fund, register ML-DSA and ML-KEM keys
 *   npm run testnet -- deploy                  deploy, register the committee, write configs
 *   npm run testnet -- demo                    one whole sealed auction with the real precompiles
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
} else if (group === "demo") {
  await (await import("./demo.ts")).demo(process.argv.slice(3));
} else {
  console.error("usage: npm run testnet -- accounts create|status | setup | deploy | demo");
  process.exit(2);
}
