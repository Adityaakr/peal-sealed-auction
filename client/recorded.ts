/**
 * Where to look first for events whose blocks are already known.
 *
 * The public RPC answers `eth_getLogs` over at most 10,000 blocks and the chain
 * adds about 60,000 blocks a day, so finding a settled auction's releases by
 * scanning back from the tip gets slower every day. These ranges are read first
 * and the scan runs only if they do not hold every event.
 *
 * A range is a hint, never evidence. The events still come from the chain, the
 * contract says how many there must be, and the audit verifies each release's
 * ML-DSA-87 signature whatever told it where to look.
 *
 * To add an auction: the first and last block of its `ReleaseSubmitted` events.
 */
import type { Address } from "viem";

export interface BlockRange {
  from: bigint;
  to: bigint;
}

/** EVM chain id, then the auction's lower-case address. */
const RELEASES: Record<string, readonly [from: bigint, to: bigint]> = {
  "9800:0x9cba5cfab2c18a939536cf02906dd543b85ec124": [10_183_622n, 10_183_634n], // testnet demo run, 16 Nov
  "9800:0x481fbb2c84582bf7c258c46bf523deebde51e990": [10_188_756n, 10_188_822n], // joint demo with Peal Bidder
  "9800:0xe5fc1b2fc5de7eeb39620915be9c1037467abe76": [10_191_806n, 10_191_819n],
  "9800:0xd919f252cd684af3822df42f160baedf61dcdf68": [10_218_890n, 10_218_898n], // PEAL-B sealed issue
  "9800:0x9a98fc3b3b5078bd22bae5fb937395ba1ae8c7b4": [10_630_882n, 10_630_945n], // first open demo
};

/** The blocks that hold an auction's releases, when they are recorded. */
export function recordedReleases(chainId: bigint, auction: Address): BlockRange | undefined {
  const r = RELEASES[`${chainId}:${auction.toLowerCase()}`];
  return r && { from: r[0], to: r[1] };
}
