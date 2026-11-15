/**
 * The 32-byte bid plaintext the contract decrypts:
 *   uint128 quantity ‖ uint16 tick ‖ 14 zero bytes
 * (`SealedAuction.encodePlaintext`).
 */
import type { Hex } from "viem";

const MAX_U128 = (1n << 128n) - 1n;
const PAD_MASK = (1n << 112n) - 1n;

export function encodePlaintext(quantity: bigint, tick: number): Hex {
  if (quantity <= 0n || quantity > MAX_U128) throw new Error("quantity must be in 1..2^128-1");
  if (!Number.isInteger(tick) || tick < 0 || tick > 0xffff) throw new Error("tick must be a uint16");
  const v = (quantity << 128n) | (BigInt(tick) << 112n);
  return `0x${v.toString(16).padStart(64, "0")}`;
}

export function decodePlaintext(pt: Hex): { quantity: bigint; tick: number; padded: boolean } {
  const v = BigInt(pt);
  return { quantity: v >> 128n, tick: Number((v >> 112n) & 0xffffn), padded: (v & PAD_MASK) === 0n };
}
