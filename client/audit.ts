/**
 * An independent audit of a settled (or opening) auction, run by anyone, for
 * example in the results page of a visitor's browser.
 *
 * The contract already checks every release signature with `pqcVerify` and
 * decrypts every bid itself. This module repeats both checks off chain, from
 * public data only, so a reader does not have to trust the contract's verdicts:
 *
 *   1. Releases. For each `ReleaseSubmitted` event it fetches the transaction,
 *      decodes the member's shares, bitmap, deadline and ML-DSA-87 signature
 *      from the calldata, rebuilds the 256-byte PqAuth message itself (the same
 *      fields `PqAuth.message` hashes, without calling the contract), reads the
 *      member's registered key from `pqcKeyStatus`, and verifies the signature
 *      with `@qorechain/pqc` (FIPS 204 ML-DSA-87).
 *   2. Bids. For each bid it takes the shares the contract stored, recombines the
 *      bid key K with any `threshold` of them, checks K against the bid's
 *      committed `keyHash`, decrypts the ciphertext and compares the plaintext
 *      with what the contract recorded (quantity and tick, or an exclusion).
 *
 * Nothing here signs or sends anything.
 */
import { mldsa87 } from "@qorechain/pqc";
import { combine, keyHash, xorSlot } from "qore-pq-kit/threshold";
import {
  decodeFunctionData,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sealedAuctionAbi } from "./abi.ts";
import { collectLogs } from "./logs.ts";
import { decodePlaintext } from "./plaintext.ts";
import { recordedReleases } from "./recorded.ts";

const PQ_AUTH_DOMAIN = keccak256(toBytes("qore-pq-kit.PqAuth.v1"));
const RELEASE_ACTION = keccak256(toBytes("SealedAuction.release"));
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as Address;
const PQC_KEY_STATUS_ABI = [
  {
    type: "function",
    name: "pqcKeyStatus",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "algorithmId", type: "uint8" },
      { name: "pubkey", type: "bytes" },
      { name: "possessionProven", type: "bool" },
    ],
  },
] as const;

/** The exact 256 bytes a member signs for its release (`SealedAuction._verifyRelease`). */
export function releaseAuthMessage(a: {
  chainId: bigint;
  auction: Address;
  member: Address;
  bidCount: number;
  shares: readonly bigint[];
  invalidBitmap: bigint;
  deadline: bigint;
}): Uint8Array {
  const argsHash = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256[]" }, { type: "uint256" }], [BigInt(a.bidCount), [...a.shares], a.invalidBitmap]),
  );
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [PQ_AUTH_DOMAIN, a.chainId, a.auction, a.member, RELEASE_ACTION, 0n, a.deadline, argsHash],
    ),
  );
}

/** Verify one release signature with ML-DSA-87 (never throws: malformed input is `false`). */
export function verifyReleaseSignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return mldsa87.verify(publicKey, message, signature);
}

export interface ReleaseCheck {
  memberIndex: number;
  member: Address;
  /** The transaction that carried the release, when its event is still readable. */
  txHash?: Hex;
  /** true: ML-DSA-87 verified here; false: it did not; undefined: not checkable (see `note`). */
  signatureOk?: boolean;
  /** The shares this release published, in bid order (for the bid check). */
  shares?: bigint[];
  invalidBitmap?: bigint;
  note?: string;
}

export interface BidCheck {
  bidId: number;
  /** What the contract recorded: 0 sealed, 1 opened, 2 excluded, 3 unopenable. */
  status: number;
  /** The plaintext reopened here, if the stored shares rebuild K. */
  reopened?: { quantity: bigint; tick: number; padded: boolean };
  /** true when the reopened plaintext agrees with the contract's record. */
  agrees?: boolean;
  note?: string;
}

export interface AuditReport {
  chainId: bigint;
  threshold: number;
  members: Address[];
  releases: ReleaseCheck[];
  bids: BidCheck[];
  /** Every release that could be checked verified, and every decided bid agrees. */
  ok: boolean;
}

type StoredBid = { bidder: Address; seq: number; status: number; quantity: bigint; tick: number; ct: Hex; keyHash: Hex };

/** Read a member's ML-DSA-87 key from the chain (`pqcKeyStatus`, by `eth_call`). */
export async function memberKey(client: PublicClient, member: Address): Promise<Uint8Array | undefined> {
  const res = await client.readContract({ address: PQC_KEY_STATUS, abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", args: [member] }).catch(() => undefined);
  if (!res) return undefined;
  const [registered, algorithmId, pubkey, possession] = res;
  const key = hexToBytes(pubkey);
  return registered && algorithmId === 1 && possession && key.length === 2592 ? key : undefined;
}

export async function auditAuction(client: PublicClient, auction: Address): Promise<AuditReport> {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;
  const [chainId, members, threshold, bidCount, cfg, latest] = await Promise.all([
    client.getChainId().then(BigInt),
    read<readonly Address[]>("members"),
    read<number>("threshold").then(Number),
    read<number>("bidCount").then(Number),
    read<{ startTime: bigint }>("config"),
    client.getBlock({ blockTag: "latest" }),
  ]);
  const ids = Array.from({ length: bidCount }, (_, i) => BigInt(i));
  const [stored, storedShares] = await Promise.all([
    Promise.all(ids.map((i) => read<StoredBid>("getBid", [i]))),
    Promise.all(ids.map((i) => read<readonly [number, readonly bigint[]]>("sharesOf", [i]))),
  ]);

  // 1. Releases: signatures checked here, from calldata.
  const age = latest.timestamp > cfg.startTime ? latest.timestamp - cfg.startTime : 0n;
  const releaseCount = Number(await read<number>("releaseCount"));
  let logs: { args: { memberIndex: number; member: Address }; transactionHash: Hex }[] = [];
  try {
    logs = await collectLogs(
      client,
      (from, to) => client.getContractEvents({ address: auction, abi: sealedAuctionAbi, eventName: "ReleaseSubmitted", fromBlock: from, toBlock: to, strict: true }),
      releaseCount,
      { maxChunks: Number(age / 9_999n) + 2, recorded: recordedReleases(chainId, auction) },
    );
  } catch {
    // the node no longer has these blocks; the releases are reported as not checkable
  }
  const keys = await Promise.all(members.map((m) => memberKey(client, m)));
  const mask = Number(await read<number>("releaseMask"));
  const releases: ReleaseCheck[] = [];
  for (let i = 0; i < members.length; i++) {
    const memberIndex = i + 1;
    const member = members[i]!;
    if (!((mask >> i) & 1)) {
      releases.push({ memberIndex, member, note: "no release" });
      continue;
    }
    const log = logs.find((l) => Number(l.args.memberIndex) === memberIndex);
    if (!log) {
      releases.push({ memberIndex, member, note: "release event not readable from this node (pruned or relayed by a smart account)" });
      continue;
    }
    const check: ReleaseCheck = { memberIndex, member, txHash: log.transactionHash };
    try {
      const tx = await client.getTransaction({ hash: log.transactionHash });
      const call = decodeFunctionData({ abi: sealedAuctionAbi, data: tx.input });
      if (call.functionName !== "submitRelease") throw new Error("not a direct submitRelease call");
      const [idx, shares, invalidBitmap, deadline, signature] = call.args as readonly [number, readonly bigint[], bigint, bigint, Hex];
      if (Number(idx) !== memberIndex) throw new Error(`calldata names member ${idx}`);
      check.shares = [...shares];
      check.invalidBitmap = invalidBitmap;
      const key = keys[i];
      if (!key) {
        check.note = "member has no usable ML-DSA-87 key on chain now";
      } else {
        const message = releaseAuthMessage({ chainId, auction, member, bidCount, shares, invalidBitmap, deadline });
        check.signatureOk = verifyReleaseSignature(key, message, hexToBytes(signature));
      }
    } catch (err) {
      check.note = `calldata not decodable here: ${err instanceof Error ? err.message : String(err)}`;
    }
    releases.push(check);
  }

  // 2. Bids: reopened here from the shares the contract stored.
  const bids: BidCheck[] = stored.map((b, i) => {
    const check: BidCheck = { bidId: i, status: Number(b.status) };
    const [shareMask, values] = storedShares[i]!;
    const have = values.flatMap((v, j) => ((Number(shareMask) >> j) & 1 ? [{ index: j + 1, value: v }] : []));
    if (have.length < threshold) {
      check.note = `${have.length} of ${threshold} shares stored`;
      if (check.status === 3) check.agrees = true; // unopenable, and indeed not enough shares
      return check;
    }
    const binding = { chainId, app: auction, sender: b.bidder, seq: BigInt(b.seq) };
    const key = combine(have.slice(0, threshold));
    if (keyHash(binding, key).toLowerCase() !== b.keyHash.toLowerCase()) {
      check.note = "stored shares do not rebuild the committed key";
      // Unopenable is exactly this case (a junk keyHash); anything else recorded would be wrong.
      check.agrees = check.status === 3;
      return check;
    }
    const pt = decodePlaintext(xorSlot(binding, key, b.ct));
    check.reopened = pt;
    if (check.status === 1) check.agrees = pt.padded && pt.quantity === BigInt(b.quantity) && pt.tick === Number(b.tick);
    else if (check.status === 2) check.agrees = true; // excluded: the contract's rule (cap, minimum, escrow, padding) decided; the plaintext is shown
    else if (check.status === 0) check.note = "not opened on chain yet";
    return check;
  });

  const ok =
    releases.every((r) => r.signatureOk !== false) &&
    bids.every((b) => b.agrees !== false) &&
    releases.some((r) => r.signatureOk === true);
  return { chainId, threshold, members: [...members], releases, bids, ok };
}
