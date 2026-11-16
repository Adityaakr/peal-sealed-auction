/**
 * A committee member's release (runs in the member's browser or daemon).
 *
 * After the on-chain close, the member reads every `BidCommitted` event, opens
 * its own envelope of each bid (QoreSeal, same purpose and AAD), checks each
 * share against the bid's committed hash, and marks a bid invalid when its
 * envelope does not open or its share does not match. It then signs one release
 * over the whole frozen set with its ML-DSA-87 key. The exact bytes to sign come
 * from the contract (`releaseMessage`), and the signature is checked locally
 * against the key the chain has registered before anything is sent.
 */
import type { SealKeyPair } from "@qorechain/qoreseal";
import { pqcSign, pqcVerify } from "@qorechain/sdk";
import { openShare } from "qore-pq-kit/threshold";
import { hexToBytes, toBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import { sealedAuctionAbi } from "./abi.ts";
import { SEAL_CHAIN_ID, SHARE_PURPOSE } from "./constants.ts";
import { collectLogs } from "./logs.ts";

export interface CommittedBid {
  bidId: bigint;
  bidder: Address;
  seq: bigint;
  ct: Hex;
  keyHash: Hex;
  shareHashes: Hex[];
  envelopes: Hex[];
  escrow: bigint;
}

/** Every committed bid, in bid id order (the order a release covers). */
export async function readBids(client: PublicClient, auction: Address, fromBlock?: bigint): Promise<CommittedBid[]> {
  const count = Number(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCount" }));
  const logs = await collectLogs(
    client,
    (from, to) =>
      client.getContractEvents({ address: auction, abi: sealedAuctionAbi, eventName: "BidCommitted", fromBlock: from, toBlock: to, strict: true }),
    count,
    { fromBlock },
  );
  const bids = logs.map((l) => ({
    bidId: l.args.bidId,
    bidder: l.args.bidder,
    seq: BigInt(l.args.seq),
    ct: l.args.ct,
    keyHash: l.args.keyHash,
    shareHashes: [...l.args.shareHashes],
    envelopes: [...l.args.envelopes],
    escrow: l.args.escrow,
  }));
  bids.sort((x, y) => (x.bidId < y.bidId ? -1 : 1));
  bids.forEach((b, i) => {
    if (b.bidId !== BigInt(i)) throw new Error(`missing BidCommitted event for bid ${i}`);
  });
  return bids;
}

export interface ReleaseShares {
  shares: bigint[];
  invalidBitmap: bigint;
  /** Why each invalid bid was flagged, for the member's log. */
  invalid: { bidId: bigint; reason: string }[];
}

/** Open this member's share of every bid. Never throws for a bad bid; flags it. */
export function openMemberShares(a: {
  chainId: bigint;
  auction: Address;
  index: number;
  keys: SealKeyPair;
  bids: readonly CommittedBid[];
  sealChainId?: string;
}): ReleaseShares {
  const shares: bigint[] = [];
  const invalid: { bidId: bigint; reason: string }[] = [];
  let invalidBitmap = 0n;
  for (const b of a.bids) {
    try {
      const value = openShare({
        envelope: hexToBytes(b.envelopes[a.index - 1]!),
        keys: a.keys,
        binding: { chainId: a.chainId, app: a.auction, sender: b.bidder, seq: b.seq },
        index: a.index,
        shareHash: b.shareHashes[a.index - 1]!,
        sealChainId: a.sealChainId ?? SEAL_CHAIN_ID,
        purpose: SHARE_PURPOSE,
      });
      shares.push(value);
    } catch (err) {
      shares.push(0n);
      invalidBitmap |= 1n << b.bidId;
      invalid.push({ bidId: b.bidId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { shares, invalidBitmap, invalid };
}

/** The 256-byte PqAuth message the member signs, read from the contract itself. */
export async function releaseMessage(
  client: PublicClient,
  auction: Address,
  index: number,
  r: ReleaseShares,
  deadline: bigint,
): Promise<Hex> {
  return client.readContract({
    address: auction,
    abi: sealedAuctionAbi,
    functionName: "releaseMessage",
    args: [index, r.shares, r.invalidBitmap, deadline],
  });
}

/** Sign with ML-DSA-87 and check the signature against `publicKey` before returning it. */
export function signRelease(pqc: { secretKey: Uint8Array; publicKey: Uint8Array }, message: Hex): Hex {
  const m = toBytes(message);
  const sig = pqcSign(pqc.secretKey, m);
  if (!pqcVerify(pqc.publicKey, m, sig)) throw new Error("local ML-DSA-87 verification of the release failed");
  return toHex(sig);
}
