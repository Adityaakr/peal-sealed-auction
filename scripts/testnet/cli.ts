/**
 * cli.ts - testnet operations for Peal Sealed Auction (qorechain-diana).
 *
 *   npm run testnet -- accounts create|status
 *   npm run testnet -- setup                   fund, register ML-DSA and ML-KEM keys
 *   npm run testnet -- deploy                  deploy, register the committee, write configs
 *   npm run testnet -- demo                    one whole sealed auction with the real precompiles
 *   npm run testnet -- create                  only open an auction (default 15 min bidding, 15 min releases)
 *   npm run testnet -- create --buyback --demo --commit-seconds 604800 --release-seconds 86400 --max-bids 20
 *                                              the visitors' open demo: 50 fUSD for faucet PEAL-T, written to the pages' config
 *   npm run testnet -- settle <auction>        wait for the close, 2 releases, open, finalize
 *   npm run testnet -- window <name> <auction> open the scoped window an account needs for the web pages
 *   npm run testnet -- close <auction>         close an auction nobody bid on and return its supply
 *   npm run testnet -- qorex-proof              the wallet drawer's QoreX funding path, through the official QoreX mock, on the testnet
 *   npm run testnet -- fusd buy <account> <fUSD> [--top-up]   buy fUSD on the AMM and convert it to the ERC-20, one transaction
 *   npm run testnet -- metamask-proof [auction]  a MetaMask key bids through bidder1's account under a spending rule (wallet adapter)
 *   npm run testnet -- bond                    a sealed issue of PEAL-B, a bond only post-quantum accounts may hold (Asset Kit guard), ~25 min
 *   npm run testnet -- audit <auction>         check every release signature (ML-DSA-87, @qorechain/pqc) and reopen every bid off chain
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
} else if (group === "qorex-proof") {
  await (await import("./qorex-proof.ts")).qorexProof();
} else if (group === "fusd") {
  await (await import("./amm.ts")).fusd(process.argv.slice(3));
} else if (group === "metamask-proof") {
  await (await import("./metamask-proof.ts")).metamaskProof(cmd);
} else if (group === "bond") {
  await (await import("./bond.ts")).bondDemo();
} else if (group === "audit") {
  await (await import("./audit.ts")).audit(cmd as `0x${string}`);
} else if (group === "demo") {
  await (await import("./demo.ts")).demo(process.argv.slice(3));
} else {
  console.error("usage: npm run testnet -- accounts create|status | setup | deploy | demo | create | window <name> <auction> | close <auction> | audit <auction>");
  process.exit(2);
}
