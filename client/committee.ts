/**
 * Reading a committee set from `CommitteeRegistry` and turning it into QoreSeal
 * recipients a bidder can seal to.
 *
 * The registry stores, per member, the SHA3-256 of its ML-KEM key and the hash
 * of its recipient card, both signed by the member's ML-DSA-87 key on chain.
 * The cards themselves are in the `MemberJoined` events. `resolveCommittee`
 * checks each member with the kit's `verifyMember`: ML-DSA key from the chain,
 * ML-KEM key from (possibly untrusted) REST against the signed hash, and the
 * card against its hash and both keys.
 */
import type { RecipientCard, SealRecipient } from "@qorechain/qoreseal";
import { verifyMember } from "qore-pq-kit/threshold";
import { bytesToString, hexToBytes, stringToBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import { committeeRegistryAbi } from "./abi.ts";
import { SEAL_CHAIN_ID } from "./constants.ts";
import { collectLogs } from "./logs.ts";

export interface CommitteeMember {
  /** 1-based share index. */
  index: number;
  address: Address;
  kemKeySha3: Hex;
  cardHash: Hex;
  card: RecipientCard;
}

export interface Committee {
  setId: Hex;
  threshold: number;
  members: CommitteeMember[];
}

/** Cards travel through the registry as UTF-8 JSON. */
export function cardToBytes(card: RecipientCard): Hex {
  return toHex(stringToBytes(JSON.stringify(card)));
}

export function cardFromBytes(bytes: Hex): RecipientCard {
  return JSON.parse(bytesToString(hexToBytes(bytes))) as RecipientCard;
}

export async function readCommittee(
  client: PublicClient,
  registry: Address,
  setId: Hex,
  fromBlock?: bigint,
): Promise<Committee> {
  const [threshold, members] = await client.readContract({
    address: registry,
    abi: committeeRegistryAbi,
    functionName: "getSet",
    args: [setId],
  });
  const logs = await collectLogs(
    client,
    (from, to) =>
      client.getContractEvents({
        address: registry,
        abi: committeeRegistryAbi,
        eventName: "MemberJoined",
        args: { setId },
        fromBlock: from,
        toBlock: to,
        strict: true,
      }),
    members.length,
    { fromBlock },
  );
  const cards = new Map<number, Hex>();
  for (const l of logs) cards.set(Number(l.args.index), l.args.card);
  return {
    setId,
    threshold: Number(threshold),
    members: members.map((m, i) => {
      const raw = cards.get(i + 1);
      if (!raw) throw new Error(`no MemberJoined event for member ${i + 1} of ${setId}`);
      return { index: i + 1, address: m.account, kemKeySha3: m.kemKeySha3, cardHash: m.cardHash, card: cardFromBytes(raw) };
    }),
  };
}

/** Check every member's three bindings and return the recipients, in share-index order. */
export async function resolveCommittee(
  committee: Committee,
  opts: { client: PublicClient; rest: string; sealChainId?: string; fetch?: typeof globalThis.fetch },
): Promise<SealRecipient[]> {
  const out: SealRecipient[] = [];
  for (const m of committee.members) {
    out.push(
      await verifyMember({
        address: m.address,
        expectKemSha3: m.kemKeySha3,
        card: m.card,
        expectCardHash: m.cardHash,
        sealChainId: opts.sealChainId ?? SEAL_CHAIN_ID,
        client: opts.client,
        rest: opts.rest,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
    );
  }
  return out;
}
