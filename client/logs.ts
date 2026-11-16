/**
 * Reading event logs within the RPC's block-range limit.
 *
 * The public QoreChain EVM RPC refuses `eth_getLogs` over more than 10,000
 * blocks ("maximum [from, to] blocks distance: 10000"), so logs are read in
 * chunks. With a known start block the chunks go forward from it; without one
 * they go backwards from the latest block until the expected number of events
 * is found (the contracts say how many there are: `bidCount`, the set size).
 */
import type { PublicClient } from "viem";

export const MAX_LOG_RANGE = 9_999n;

export async function collectLogs<T>(
  client: PublicClient,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  want: number,
  opts: { fromBlock?: bigint; maxChunks?: number } = {},
): Promise<T[]> {
  const latest = await client.getBlockNumber();
  const out: T[] = [];
  const maxChunks = opts.maxChunks ?? 2_000;
  if (opts.fromBlock !== undefined) {
    for (let from = opts.fromBlock, i = 0; from <= latest && i < maxChunks; from += MAX_LOG_RANGE + 1n, i++) {
      const to = from + MAX_LOG_RANGE > latest ? latest : from + MAX_LOG_RANGE;
      out.push(...(await read(from, to)));
    }
    return out;
  }
  for (let to = latest, i = 0; out.length < want && i < maxChunks; i++) {
    const from = to > MAX_LOG_RANGE ? to - MAX_LOG_RANGE : 0n;
    out.unshift(...(await read(from, to)));
    if (from === 0n) break;
    to = from - 1n;
  }
  return out;
}
