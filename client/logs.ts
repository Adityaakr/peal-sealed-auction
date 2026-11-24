/**
 * Reading event logs within the RPC's block-range limit.
 *
 * The public QoreChain EVM RPC refuses `eth_getLogs` over more than 10,000
 * blocks ("maximum [from, to] blocks distance: 10000"), so logs are read in
 * chunks. With a known start block the chunks go forward from it; without one
 * they go backwards from the latest block until the expected number of events
 * is found (the contracts say how many there are: `bidCount`, the set size).
 *
 * When the events' blocks are already recorded (`recorded.ts`), that range is read
 * first, and the scan runs only if it does not hold every event.
 *
 * The public node also prunes old blocks ("height N is not available, lowest
 * height is M", about two hours of history on 2026-11-16), so a backwards scan
 * stops at the lowest height the node still has.
 */
import type { PublicClient } from "viem";

export const MAX_LOG_RANGE = 9_999n;

export async function collectLogs<T>(
  client: PublicClient,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  want: number,
  opts: { fromBlock?: bigint; maxChunks?: number; recorded?: { from: bigint; to: bigint } } = {},
): Promise<T[]> {
  if (opts.recorded) {
    const found = await read(opts.recorded.from, opts.recorded.to).catch(() => []);
    if (found.length >= want) return found;
  }
  // No cache: viem otherwise reuses the block number for its polling interval,
  // and a read right after a transaction would stop before that transaction's block.
  const latest = await client.getBlockNumber({ cacheTime: 0 });
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
    let from = to > MAX_LOG_RANGE ? to - MAX_LOG_RANGE : 0n;
    try {
      out.unshift(...(await read(from, to)));
    } catch (err) {
      // A pruned node refuses ranges below its lowest height: read what it still has, then stop.
      const floor = lowestAvailable(err);
      if (floor === undefined || floor > to) throw err;
      from = floor;
      out.unshift(...(await read(from, to)));
      break;
    }
    if (from === 0n) break;
    to = from - 1n;
  }
  return out;
}

/** The node's lowest available height, from a "height N is not available, lowest height is M" error. */
export function lowestAvailable(err: unknown): bigint | undefined {
  const m = /lowest height is (\d+)/.exec(err instanceof Error ? `${err.message} ${String((err as { details?: string }).details ?? "")}` : String(err));
  return m ? BigInt(m[1]!) : undefined;
}
