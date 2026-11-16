/**
 * member.ts - one step of a committee member's work, shared by the daemon and
 * the local end-to-end run.
 *
 * A member does nothing until the auction is closed ON CHAIN (`state == Closed`;
 * releasing on a clock instead would let a member be tricked into releasing
 * while bidding is still open). Then it opens its own share of every bid,
 * signs one release over the frozen set with its ML-DSA-87 key, and sends it.
 * As a keeper (optional, permissionless) it also opens the bids and finalizes
 * once no more releases can arrive.
 */
import type { SealKeyPair } from "@qorechain/qoreseal";
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { sealedAuctionAbi } from "../../client/abi.ts";
import { openMemberShares, readBids, releaseMessage, signRelease } from "../../client/release.ts";

export const STATES = ["Created", "Funded", "CommitOpen", "Closed", "Settled", "Failed", "Cancelled"] as const;

export interface MemberIdentity {
  address: Address;
  pqc: { publicKey: Uint8Array; secretKey: Uint8Array };
  seal: SealKeyPair;
}

/** Sends one transaction and resolves with its hash once it is mined successfully. */
export type Send = (tx: { to: Address; data: Hex }) => Promise<Hex>;

export interface StepArgs {
  client: PublicClient;
  auction: Address;
  me: MemberIdentity;
  send: Send;
  /** Seconds the release signature stays valid. */
  releaseTtl?: bigint;
  /** REST base URL: finds envelopes of smart-account bids, whose EVM logs are not indexed. */
  rest?: string;
  /** Also open bids and finalize when the release window is over. */
  keeper?: boolean;
  /** Called with the exact signed bytes before the release is sent (local runs use it). */
  beforeSubmit?: (message: Hex, signature: Hex) => Promise<void>;
  log?: (line: string) => void;
}

export type StepResult =
  | { kind: "waiting"; state: string }
  | { kind: "released"; tx: Hex; invalid: number }
  | { kind: "already-released" }
  | { kind: "too-late" }
  | { kind: "opened"; tx: Hex }
  | { kind: "finalized"; tx: Hex }
  | { kind: "terminal"; state: string };

export async function memberStep(a: StepArgs): Promise<StepResult> {
  const log = a.log ?? (() => {});
  const read = <T>(functionName: string, args: unknown[] = []) =>
    a.client.readContract({ address: a.auction, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;

  const state = STATES[Number(await read<number>("state"))]!;
  if (state === "Settled" || state === "Failed" || state === "Cancelled") return { kind: "terminal", state };
  if (state !== "Closed") return { kind: "waiting", state };

  const members = await read<readonly Address[]>("members");
  const index = members.findIndex((m) => m.toLowerCase() === a.me.address.toLowerCase()) + 1;
  if (index === 0) throw new Error(`${a.me.address} is not a member of ${a.auction}'s committee`);

  const mask = Number(await read<number>("releaseMask"));
  const cfg = await read<{ releaseDeadline: bigint }>("config");
  const block = await a.client.getBlock();
  const now = block.timestamp;

  if ((mask & (1 << (index - 1))) === 0) {
    if (now > cfg.releaseDeadline) return { kind: "too-late" };
    const chainId = BigInt(await a.client.getChainId());
    const bids = await readBids(a.client, a.auction, { rest: a.rest });
    const r = openMemberShares({ chainId, auction: a.auction, index, keys: a.me.seal, bids });
    for (const x of r.invalid) log(`member ${index}: bid ${x.bidId} flagged invalid (${x.reason})`);
    const deadline = now + (a.releaseTtl ?? 600n);
    const message = await releaseMessage(a.client, a.auction, index, r, deadline);
    const signature = signRelease(a.me.pqc, message);
    if (a.beforeSubmit) await a.beforeSubmit(message, signature);
    const tx = await a.send({
      to: a.auction,
      data: encodeFunctionData({
        abi: sealedAuctionAbi,
        functionName: "submitRelease",
        args: [index, r.shares, r.invalidBitmap, deadline, signature],
      }),
    });
    log(`member ${index}: released ${bids.length} shares (${r.invalid.length} flagged), tx ${tx}`);
    return { kind: "released", tx, invalid: r.invalid.length };
  }

  if (!a.keeper) return { kind: "already-released" };
  if (!(await read<boolean>("releaseWindowOver"))) return { kind: "already-released" };
  const [count, decided] = await Promise.all([read<number>("bidCount"), read<number>("decidedCount")]);
  if (Number(decided) < Number(count)) {
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
    const tx = await a.send({ to: a.auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "openBids", args: [ids] }) });
    log(`keeper: opened ${ids.length} bids, tx ${tx}`);
    return { kind: "opened", tx };
  }
  const tx = await a.send({ to: a.auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "finalize" }) });
  log(`keeper: finalized, tx ${tx}`);
  return { kind: "finalized", tx };
}
