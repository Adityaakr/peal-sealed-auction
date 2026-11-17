/**
 * Buying the quote token on QoreChain's native AMM (`x/amm`), for a bidder who
 * holds QOR but not enough fUSD to bid in a sale.
 *
 * A browser guest account is funded with QOR (faucet or QoreX); the fest's fUSD
 * faucet pays only dashboard-registered accounts. So for a guest the AMM is the
 * on-chain way to get the escrow a fUSD sale needs. One hybrid-signed native
 * transaction carries two messages:
 *
 *   1. `MsgSwapExactIn`  QOR in, fUSD out (the bank coin `erc20:0x…`), with a
 *                        floor `minOut` of exactly the amount wanted;
 *   2. `MsgConvertCoin`  that amount of the bank coin into the ERC-20 the
 *                        auction pulls, to the bidder's own 0x address.
 *
 * If the swap would pay less than wanted, the whole transaction fails and
 * nothing moves. Any excess stays as the bank coin.
 *
 * Pricing follows the module's rules (docs: x/amm, read 17 November 2026):
 * constant product, a 0.30 % fee on the input, and a cap of 5 % price impact
 * per swap.
 */
import { Registry, type EncodeObject, type GeneratedType } from "@cosmjs/proto-signing";
import { msg as sdkMsg, qorechainRegistryTypes } from "@qorechain/sdk";
import { BinaryReader, BinaryWriter } from "cosmjs-types/binary";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import type { Address } from "viem";

export const SWAP_FEE_BPS = 30n;
/** The module refuses a swap that moves the price by more than 5 %; stay well inside it. */
export const MAX_SHARE_OF_RESERVE_BPS = 200n;

export interface Pool {
  id: string;
  pool_type: string;
  token_a: string;
  token_b: string;
  reserve_a: string;
  reserve_b: string;
  status: string;
}

/** The bank denom of an ERC-20 that the erc20 module pairs (`erc20:0x…`). */
export function bankDenomOf(erc20: Address): string {
  return `erc20:${erc20}`;
}

export async function fetchPools(rest: string, f: typeof globalThis.fetch = globalThis.fetch): Promise<Pool[]> {
  const r = await f(`${rest.replace(/\/+$/, "")}/qorechain/amm/v1/pools`);
  if (!r.ok) throw new Error(`AMM pools: HTTP ${r.status}`);
  const body = (await r.json()) as { pools?: Pool[] };
  return body.pools ?? [];
}

/** The active constant-product pool between `a` and `b` with the deepest `b` side, if any. */
export function findPool(pools: readonly Pool[], a: string, b: string): Pool | undefined {
  const lc = (s: string) => s.toLowerCase();
  return pools
    .filter((p) => p.status === "active" && p.pool_type === "constant_product")
    .filter((p) => (lc(p.token_a) === lc(a) && lc(p.token_b) === lc(b)) || (lc(p.token_a) === lc(b) && lc(p.token_b) === lc(a)))
    .sort((x, y) => Number(reserveOf(y, b) - reserveOf(x, b)))[0];
}

export function reserveOf(p: Pool, denom: string): bigint {
  return BigInt(p.token_a.toLowerCase() === denom.toLowerCase() ? p.reserve_a : p.reserve_b);
}

/** Output of a constant-product swap with the fee taken from the input. */
export function amountOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps = SWAP_FEE_BPS): bigint {
  const inAfterFee = (amountIn * (10_000n - feeBps)) / 10_000n;
  return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
}

/** The smallest input that pays at least `out`. */
export function amountInFor(reserveIn: bigint, reserveOut: bigint, out: bigint, feeBps = SWAP_FEE_BPS): bigint {
  if (out <= 0n) return 0n;
  if (out >= reserveOut) throw new Error("the pool does not hold that much");
  const num = reserveIn * out * 10_000n;
  const den = (reserveOut - out) * (10_000n - feeBps);
  let x = num / den + 1n;
  while (amountOut(reserveIn, reserveOut, x, feeBps) < out) x += 1n;
  return x;
}

export interface BuyQuote {
  poolId: string;
  denomIn: string;
  denomOut: string;
  /** What is wanted, and the floor of the swap. */
  want: bigint;
  /** What is sent in, with `slippageBps` on top of the exact quote. */
  amountIn: bigint;
}

/** Quote buying `want` of `denomOut` with `denomIn` in `pool`, with room for the pool to move by `slippageBps`. */
export function quoteBuy(pool: Pool, denomIn: string, denomOut: string, want: bigint, slippageBps = 100n): BuyQuote {
  const rIn = reserveOf(pool, denomIn);
  const rOut = reserveOf(pool, denomOut);
  if (want * 10_000n > rOut * MAX_SHARE_OF_RESERVE_BPS) {
    throw new Error(`buying ${want} would take more than ${Number(MAX_SHARE_OF_RESERVE_BPS) / 100} % of the pool's ${rOut}; buy less`);
  }
  const exact = amountInFor(rIn, rOut, want);
  return { poolId: pool.id, denomIn, denomOut, want, amountIn: (exact * (10_000n + slippageBps) + 9_999n) / 10_000n };
}

export const MSG_CONVERT_COIN_TYPE_URL = "/cosmos.evm.erc20.v1.MsgConvertCoin";

interface MsgConvertCoin {
  coin?: Coin;
  receiver: string;
  sender: string;
}

/** `cosmos.evm.erc20.v1.MsgConvertCoin`, which the SDK's registry does not carry. */
const MsgConvertCoinCodec = {
  encode(m: MsgConvertCoin, writer: BinaryWriter = BinaryWriter.create()): BinaryWriter {
    if (m.coin) Coin.encode(m.coin, writer.uint32(10).fork()).ldelim();
    if (m.receiver) writer.uint32(18).string(m.receiver);
    if (m.sender) writer.uint32(26).string(m.sender);
    return writer;
  },
  decode(input: BinaryReader | Uint8Array, length?: number): MsgConvertCoin {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const m: MsgConvertCoin = { receiver: "", sender: "" };
    while (reader.pos < end) {
      const tag = reader.uint32();
      if (tag >>> 3 === 1) m.coin = Coin.decode(reader, reader.uint32());
      else if (tag >>> 3 === 2) m.receiver = reader.string();
      else if (tag >>> 3 === 3) m.sender = reader.string();
      else reader.skipType(tag & 7);
    }
    return m;
  },
  fromPartial(o: Partial<MsgConvertCoin>): MsgConvertCoin {
    return { coin: o.coin ? Coin.fromPartial(o.coin) : undefined, receiver: o.receiver ?? "", sender: o.sender ?? "" };
  },
};

/** The SDK's registry (which has the AMM messages) plus `MsgConvertCoin`. */
export function ammRegistry(): Registry {
  const r = new Registry(qorechainRegistryTypes as Iterable<[string, GeneratedType]>);
  r.register(MSG_CONVERT_COIN_TYPE_URL, MsgConvertCoinCodec as unknown as GeneratedType);
  return r;
}

/** The two messages of one buy: swap with a floor of `want`, then convert exactly `want` to the ERC-20 at `receiver0x`. */
export function buyMessages(sender: string, receiver0x: Address, q: BuyQuote): EncodeObject[] {
  return [
    sdkMsg.amm.swapExactIn({ sender, poolId: q.poolId, tokenIn: { denom: q.denomIn, amount: q.amountIn.toString() }, denomOut: q.denomOut, minOut: q.want.toString() }),
    { typeUrl: MSG_CONVERT_COIN_TYPE_URL, value: { coin: { denom: q.denomOut, amount: q.want.toString() }, receiver: receiver0x, sender } },
  ];
}
