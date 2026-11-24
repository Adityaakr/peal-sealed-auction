/**
 * How much a bid puts in escrow, and what that tells an observer.
 *
 * A bid's quantity and price limit are sealed, but its escrow is a public token
 * transfer. The contract needs at least quantity x limit and refunds whatever is
 * not spent, so escrowing exactly that would publish the product, rounded up to
 * the token's last decimal: with 8 price steps, at most 8 (whole quantity, limit)
 * pairs give it. So the pages round the escrow up to a bucket shared by many bids.
 * What still leaks is the bucket: the product is at most the bucket and, for a
 * bidder who took the default, above the one below.
 */

/** What the contract requires for a bid (`AuctionMath.escrowFor`): quantity x limit, rounded up. */
export function escrowNeeded(
  a: { reservePrice: bigint; tickSize: bigint; saleDecimals: number },
  quantity: bigint,
  tick: number,
): bigint {
  const price = a.reservePrice + BigInt(tick) * a.tickSize;
  const one = 10n ** BigInt(a.saleDecimals);
  const need = (quantity * price + one - 1n) / one;
  return need === 0n ? 1n : need; // the contract refuses an escrow of 0
}

/** The smallest of 10, 25, 50, 100, 250, 500, ... that covers `need` (base units of a token with `decimals`). */
export function roundUp(need: bigint, decimals: number): bigint {
  for (let step = 10n * 10n ** BigInt(decimals); ; step *= 10n) {
    for (const b of [step, (step * 5n) / 2n, step * 5n]) if (need <= b) return b;
  }
}

/**
 * The buckets of an auction whose largest bid needs `most`: the round numbers up to
 * half of `most`, then `most` itself. Without that cut the last bucket would hold only
 * the few largest bids: on the demo auction, 6 of the 400 whole-fUSD bids.
 */
export function escrowLadder(most: bigint, decimals: number): bigint[] {
  const out: bigint[] = [];
  for (let b = roundUp(1n, decimals); b * 2n <= most; b = roundUp(b + 1n, decimals)) out.push(b);
  return [...out, most];
}

/** How the bidder wants its escrow chosen. */
export type EscrowMode = "bucket" | "wider" | "cover-all" | "exact";

/**
 * The escrow for a bid that needs `need`, in an auction whose largest bid needs `most`:
 * - `bucket` (the default): the smallest bucket that covers it;
 * - `wider`: one bucket further up;
 * - `cover-all`: what the whole supply at the top price needs, so any bid could
 *   have made the same transfer;
 * - `exact`: quantity x limit itself, which publishes the product.
 * A bid for more than the supply needs more than `most` and is rounded up plainly.
 */
export function escrowChoice(mode: EscrowMode, need: bigint, most: bigint, decimals: number): bigint {
  if (mode === "exact") return need;
  if (need > most) return roundUp(need, decimals);
  if (mode === "cover-all") return most;
  const fits = escrowLadder(most, decimals).filter((b) => b >= need);
  return (mode === "wider" ? fits[1] : undefined) ?? fits[0]!;
}

/** Whole-number bids an observer cannot rule out from one public escrow (`escrow.test.ts` measures these). */
export function candidates(
  a: { reservePrice: bigint; tickSize: bigint; numTicks: number; saleDecimals: number; totalSupply: bigint },
  fits: (need: bigint) => boolean,
): { quantity: bigint; tick: number }[] {
  const one = 10n ** BigInt(a.saleDecimals);
  const out: { quantity: bigint; tick: number }[] = [];
  for (let q = one; q <= a.totalSupply; q += one) {
    for (let tick = 0; tick < a.numTicks; tick++) if (fits(escrowNeeded(a, q, tick))) out.push({ quantity: q, tick });
  }
  return out;
}
