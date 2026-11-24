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
import { pqcSign } from "@qorechain/sdk";
import { verifyReleaseSignature } from "./audit.ts";
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
  /** Further envelope sets claiming to be this bid's (a vault bid's, from calldata anyone can imitate); the first that opens counts. */
  alternates?: Hex[][];
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
 *      through the REST transaction search (`rest`): either `commitBid` sent by
 *      the bidder itself, or `bid(auction, ...)` sent to a vault, whose bidder is
 *      the vault (`bidderVaultAbi`).
 * A bid whose envelopes cannot be found gets none; the member then flags it. A
 * search that fails part-way throws instead: a bid flagged by every member
 * loses its bond, so a busy REST node must not look like a missing envelope.
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
  const missing = bids.filter((b) => b.envelopes.length === 0);
  if (opts.rest && missing.length > 0) {
    const found = await executeEvmBids(opts.rest, auction, { fetch: opts.fetch, since: cfg.startTime });
    const direct = new Map<string, Hex[]>();
    const viaVault = new Map<string, ExecuteEvmBid[]>();
    for (const x of found) {
      const key = `${x.bidder}:${x.seq}`;
      if (x.lane === "account") direct.set(key, x.envelopes);
      else if (!viaVault.get(key)?.push(x)) viaVault.set(key, [x]);
    }
    for (const b of missing) {
      const key = `${b.bidder.toLowerCase()}:${b.seq}`;
      const own = direct.get(key);
      if (own) {
        b.envelopes = own;
        continue;
      }
      const sets = vaultCandidates(b, viaVault.get(key) ?? []);
      b.envelopes = sets[0] ?? [];
      if (sets.length > 1) b.alternates = sets.slice(1);
    }
  }
  return bids;
}

const EXECUTE_EVM = "/qorechain.abstractaccount.v1.MsgExecuteEVM";

/**
 * The call a bidder vault takes: `commitBid`'s arguments behind the auction's
 * address. The vault sends `commitBid`, so it is the bidder on chain. Any vault
 * with this function works; nothing here trusts one.
 */
export const bidderVaultAbi = [
  {
    type: "function",
    name: "bid",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auction", type: "address" },
      { name: "seq", type: "uint32" },
      { name: "ct", type: "bytes32" },
      { name: "keyHash", type: "bytes32" },
      { name: "shareHashes", type: "bytes32[]" },
      { name: "envelopes", type: "bytes[]" },
      { name: "escrow", type: "uint256" },
    ],
    outputs: [{ name: "bidId", type: "uint256" }],
  },
] as const;

/** SealedAuction.MAX_ENVELOPE_BYTES. */
const MAX_ENVELOPE_BYTES = 4096;
/** Seven envelopes of the largest size, as base64, with room for the rest of the call. */
const MAX_VAULT_CALL_BASE64 = 48_000;
/** Envelope sets tried for one vault bid. */
export const MAX_VAULT_CANDIDATES = 16;

/** A bid found in a successful `MsgExecuteEVM`. `account`: sent by the bidder to the auction. `vault`: sent to the bidder, a vault. */
export interface ExecuteEvmBid {
  lane: "account" | "vault";
  /** Lower-case address. */
  bidder: Address;
  seq: bigint;
  ct: Hex;
  keyHash: Hex;
  shareHashes: Hex[];
  envelopes: Hex[];
}

/**
 * The envelope sets worth trying for a vault bid, oldest first.
 *
 * The chain authenticates the sender of a `MsgExecuteEVM`, not its target, so
 * anyone can send a `bid(...)` to an address that accepts any call (one with no
 * code, for example) and copy a real bid's public hashes around junk envelopes. A copy
 * can only follow the bid it copies, hence oldest first, and the member tries
 * each set until its share matches the on-chain hash (`openMemberShares`).
 */
function vaultCandidates(b: CommittedBid, newestFirst: readonly ExecuteEvmBid[]): Hex[][] {
  const out: Hex[][] = [];
  const seen = new Set<string>();
  for (const x of [...newestFirst].reverse()) {
    if (x.ct !== b.ct || x.keyHash !== b.keyHash || x.shareHashes.join() !== b.shareHashes.join()) continue;
    if (x.envelopes.length !== b.shareHashes.length || x.envelopes.some((e) => e === "0x" || (e.length - 2) / 2 > MAX_ENVELOPE_BYTES)) continue;
    const id = x.envelopes.join();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(x.envelopes);
    if (out.length === MAX_VAULT_CANDIDATES) break;
  }
  return out;
}

interface TxSearch {
  total?: string;
  tx_responses?: {
    code: number;
    timestamp?: string;
    events?: { type: string; attributes?: { key: string; value: string }[] }[];
    tx: { body: { messages: { "@type": string; account?: string; to?: string; data?: string }[] } };
  }[];
}

/**
 * Bids for `auction` carried by successful MsgExecuteEVM transactions, newest
 * first: `commitBid` sent to the auction, and `bid(auction, ...)` sent to a
 * vault. The search stops at the auction's start (`since`, unix seconds), at
 * the end of the results, or after `maxPages`. Throws when a page cannot be read.
 */
export async function executeEvmBids(
  rest: string,
  auction: Address,
  opts: { fetch?: typeof globalThis.fetch; since?: bigint; maxPages?: number; retryMs?: number } = {},
): Promise<ExecuteEvmBid[]> {
  const out: ExecuteEvmBid[] = [];
  const target = auction.toLowerCase();
  let seen = 0;
  for (let page = 1; page <= (opts.maxPages ?? 100); page++) {
    const body = await searchPage(rest, page, opts.fetch ?? globalThis.fetch, opts.retryMs ?? 500);
    const txs = body?.tx_responses ?? [];
    for (const t of txs) {
      if (t.code !== 0) continue;
      const failures = (t.events ?? []).filter((e) => e.type === "abstractaccount_execution_failed");
      for (const [i, m] of t.tx.body.messages.entries()) {
        if (m["@type"] !== EXECUTE_EVM || !m.to || !m.data || !m.account) continue;
        try {
          const to = m.to.toLowerCase() as Address;
          if (to === target) {
            if (failures.length > 0) continue;
            const call = decodeFunctionData({ abi: sealedAuctionAbi, data: base64ToHex(m.data) });
            if (call.functionName !== "commitBid") continue;
            const [seq, ct, keyHash, hashes, envs] = call.args as readonly [number, Hex, Hex, readonly Hex[], readonly Hex[], bigint];
            out.push({ lane: "account", bidder: bech32ToHex(m.account).toLowerCase() as Address, seq: BigInt(seq), ct, keyHash, shareHashes: [...hashes], envelopes: [...envs] });
          } else {
            // A failure event names its message; one that does not is taken to cover them all.
            if (failures.some((e) => (e.attributes?.find((x) => x.key === "msg_index")?.value ?? String(i)) === String(i))) continue;
            if (!/^0x[0-9a-f]{40}$/.test(to) || m.data.length > MAX_VAULT_CALL_BASE64) continue;
            const { args } = decodeFunctionData({ abi: bidderVaultAbi, data: base64ToHex(m.data) });
            const [forAuction, seq, ct, keyHash, hashes, envs] = args;
            if (forAuction.toLowerCase() !== target) continue;
            out.push({ lane: "vault", bidder: to, seq: BigInt(seq), ct, keyHash, shareHashes: [...hashes], envelopes: [...envs] });
          }
        } catch {
          // not a bid we can decode
        }
      }
    }
    seen += txs.length;
    const total = Number(body?.total ?? Number.NaN);
    if (txs.length === 0 || (Number.isNaN(total) ? txs.length < 50 : seen >= total)) break;
    // No bid is older than the start of bidding.
    const oldest = Date.parse(txs[txs.length - 1]!.timestamp ?? "");
    if (opts.since !== undefined && oldest / 1000 < Number(opts.since)) break;
  }
  return out;
}

/** One page of the search; undefined past the last page. Retries a failed read twice, then throws. */
async function searchPage(rest: string, page: number, f: typeof globalThis.fetch, retryMs: number): Promise<TxSearch | undefined> {
  const q = encodeURIComponent(`message.action='${EXECUTE_EVM}'`);
  const url = `${rest.replace(/\/+$/, "")}/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&limit=100&page=${page}`;
  for (let attempt = 0; ; attempt++) {
    let why: string;
    try {
      const res = await f(url);
      if (res.ok) return (await res.json()) as TxSearch;
      // The node answers HTTP 500 past the last page: "page should be within [1, 7] range, given 8".
      const last = /page should be within \[1, (\d+)\] range/.exec(await res.text())?.[1];
      if (last !== undefined && page > Number(last)) return undefined;
      why = `HTTP ${res.status}`;
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (attempt === 2) throw new Error(`transaction search for bid envelopes failed at page ${page}: ${why}`);
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

function base64ToHex(b64: string): Hex {
  return toHex(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
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
    let value: bigint | undefined;
    let reason: string | undefined;
    for (const set of [b.envelopes, ...(b.alternates ?? [])]) {
      try {
        const env = set[a.index - 1];
        if (!env) throw new Error("no envelope found for this bid");
        value = openShare({
          envelope: hexToBytes(env),
          keys: a.keys,
          binding: { chainId: a.chainId, app: a.auction, sender: b.bidder, seq: b.seq },
          index: a.index,
          shareHash: b.shareHashes[a.index - 1]!,
          sealChainId: a.sealChainId ?? SEAL_CHAIN_ID,
          purpose: SHARE_PURPOSE,
        });
        break;
      } catch (err) {
        reason ??= err instanceof Error ? err.message : String(err);
      }
    }
    if (value === undefined) {
      shares.push(0n);
      invalidBitmap |= 1n << b.bidId;
      invalid.push({ bidId: b.bidId, reason: reason! });
    } else {
      shares.push(value);
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

/** Sign with ML-DSA-87 (SDK) and check the signature against `publicKey` with `@qorechain/pqc` before returning it. */
export function signRelease(pqc: { secretKey: Uint8Array; publicKey: Uint8Array }, message: Hex): Hex {
  const m = toBytes(message);
  const sig = pqcSign(pqc.secretKey, m);
  if (!verifyReleaseSignature(pqc.publicKey, m, sig)) throw new Error("local ML-DSA-87 verification of the release failed");
  return toHex(sig);
}
