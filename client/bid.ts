/**
 * Sealing one bid (runs in the bidder's browser or the agent).
 *
 * K is drawn fresh, the plaintext is encrypted under K in one block, K is split
 * t-of-n and each share is sealed with QoreSeal (ML-KEM-1024 + X25519) to one
 * member. Everything is bound to (EVM chain id, auction, bidder, seq), where
 * seq is the bidder's own counter on the auction.
 */
import type { SealRecipient } from "@qorechain/qoreseal";
import { sealSlot } from "qore-pq-kit/threshold";
import { toHex, type Address, type Hex, type PublicClient } from "viem";
import { sealedAuctionAbi } from "./abi.ts";
import { SEAL_CHAIN_ID, SHARE_PURPOSE } from "./constants.ts";
import { encodePlaintext } from "./plaintext.ts";

export interface SealBidArgs {
  chainId: bigint;
  auction: Address;
  bidder: Address;
  seq: bigint;
  quantity: bigint;
  tick: number;
  /** Member j is recipients[j - 1], already checked with `resolveCommittee`. */
  recipients: readonly SealRecipient[];
  threshold: number;
  sealChainId?: string;
  /** Tests only. */
  key?: bigint;
  random?: () => bigint;
}

export interface CommitArgs {
  seq: number;
  ct: Hex;
  keyHash: Hex;
  shareHashes: Hex[];
  envelopes: Hex[];
}

export function sealBid(a: SealBidArgs): CommitArgs {
  const sealed = sealSlot({
    binding: { chainId: a.chainId, app: a.auction, sender: a.bidder, seq: a.seq },
    plaintext: encodePlaintext(a.quantity, a.tick),
    committee: a.recipients,
    threshold: a.threshold,
    sealChainId: a.sealChainId ?? SEAL_CHAIN_ID,
    purpose: SHARE_PURPOSE,
    ...(a.key !== undefined ? { key: a.key } : {}),
    ...(a.random ? { random: a.random } : {}),
  });
  return {
    seq: Number(a.seq),
    ct: sealed.ct,
    keyHash: sealed.keyHash,
    shareHashes: sealed.shareHashes,
    envelopes: sealed.envelopes.map((e) => toHex(e)),
  };
}

/** What a bidder needs to read before sealing: its seq and the escrow its bid needs. */
export async function bidContext(
  client: PublicClient,
  auction: Address,
  bidder: Address,
  quantity: bigint,
  tick: number,
): Promise<{ seq: bigint; escrow: bigint; bond: bigint }> {
  const [seq, escrow, cfg] = await Promise.all([
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCountOf", args: [bidder] }),
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "escrowFor", args: [quantity, tick] }),
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" }),
  ]);
  return { seq: BigInt(seq), escrow: escrow === 0n ? 1n : escrow, bond: cfg.bidBond };
}
