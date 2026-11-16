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
import { bech32 } from "@scure/base";
import { decodeFunctionData, hexToBytes, toBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
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

/**
 * Every committed bid, in bid id order (the order a release covers).
 *
 * What a member must trust comes from contract storage: bidder, seq, ct,
 * keyHash and the share hashes. The envelopes are only transport (each opened
 * share is checked against its on-chain hash), so they may come from anywhere:
 *   1. `BidCommitted` event logs, when the RPC still has them;
 *   2. otherwise the calldata of the `MsgExecuteEVM` that carried the commit
 *      (a smart-account bid, whose EVM logs the JSON-RPC does not index), found
 *      through the REST transaction search (`rest`).
 * A bid whose envelopes cannot be found gets none; the member then flags it.
 */
export async function readBids(
  client: PublicClient,
  auction: Address,
  opts: { fromBlock?: bigint; rest?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<CommittedBid[]> {
  const count = Number(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCount" }));
  const ids = Array.from({ length: count }, (_, i) => BigInt(i));
  const [stored, hashes] = await Promise.all([
    Promise.all(ids.map((i) => client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [i] }))),
    Promise.all(ids.map((i) => client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "shareHashesOf", args: [i] }))),
  ]);
  const envelopes = new Map<bigint, Hex[]>();
  // Bound a backwards scan by the auction's age (blocks are no faster than one a second here).
  const [cfg, latest] = await Promise.all([
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" }),
    client.getBlock({ blockTag: "latest" }),
  ]);
  const age = latest.timestamp > cfg.startTime ? latest.timestamp - cfg.startTime : 0n;
  const maxChunks = Number(age / 9_999n) + 2;
  try {
    const logs = await collectLogs(
      client,
      (from, to) =>
        client.getContractEvents({ address: auction, abi: sealedAuctionAbi, eventName: "BidCommitted", fromBlock: from, toBlock: to, strict: true }),
      count,
      { fromBlock: opts.fromBlock, maxChunks },
    );
    for (const l of logs) envelopes.set(l.args.bidId, [...l.args.envelopes]);
  } catch {
    // fall through to the transaction search
  }
  const bids: CommittedBid[] = stored.map((b, i) => ({
    bidId: BigInt(i),
    bidder: b.bidder,
    seq: BigInt(b.seq),
    ct: b.ct,
    keyHash: b.keyHash,
    shareHashes: [...hashes[i]!],
    envelopes: envelopes.get(BigInt(i)) ?? [],
    escrow: b.escrow,
  }));
  if (opts.rest && bids.some((b) => b.envelopes.length === 0)) {
    const found = await envelopesFromExecuteEvm(opts.rest, auction, opts.fetch);
    for (const b of bids) {
      if (b.envelopes.length === 0) b.envelopes = found.get(`${b.bidder.toLowerCase()}:${b.seq}`) ?? [];
    }
  }
  return bids;
}

const EXECUTE_EVM = "/qorechain.abstractaccount.v1.MsgExecuteEVM";

/** commitBid envelopes carried by successful MsgExecuteEVM transactions to `auction`, keyed by "bidder:seq". */
export async function envelopesFromExecuteEvm(
  rest: string,
  auction: Address,
  f: typeof globalThis.fetch = globalThis.fetch,
  maxPages = 10,
): Promise<Map<string, Hex[]>> {
  const out = new Map<string, Hex[]>();
  const q = encodeURIComponent(`message.action='${EXECUTE_EVM}'`);
  for (let page = 1; page <= maxPages; page++) {
    const res = await f(`${rest.replace(/\/+$/, "")}/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&pagination.limit=50&page=${page}`);
    if (!res.ok) break;
    const body = (await res.json()) as {
      tx_responses?: { code: number; events?: { type: string }[]; tx: { body: { messages: { "@type": string; account?: string; to?: string; data?: string }[] } } }[];
    };
    const txs = body.tx_responses ?? [];
    for (const t of txs) {
      if (t.code !== 0 || t.events?.some((e) => e.type === "abstractaccount_execution_failed")) continue;
      for (const m of t.tx.body.messages) {
        if (m["@type"] !== EXECUTE_EVM || !m.to || !m.data || !m.account) continue;
        if (m.to.toLowerCase() !== auction.toLowerCase()) continue;
        try {
          const data = toHex(Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)));
          const call = decodeFunctionData({ abi: sealedAuctionAbi, data });
          if (call.functionName !== "commitBid") continue;
          const [seq, , , , envs] = call.args as readonly [number, Hex, Hex, readonly Hex[], readonly Hex[], bigint];
          out.set(`${bech32ToHex(m.account).toLowerCase()}:${BigInt(seq)}`, [...envs]);
        } catch {
          // not a commitBid we can decode
        }
      }
    }
    if (txs.length < 50) break;
  }
  return out;
}

function bech32ToHex(addr: string): Address {
  const { words } = bech32.decode(addr as `${string}1${string}`, 90);
  return toHex(Uint8Array.from(bech32.fromWords(words))) as Address;
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
      const env = b.envelopes[a.index - 1];
      if (!env) throw new Error("no envelope found for this bid");
      const value = openShare({
        envelope: hexToBytes(env),
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
