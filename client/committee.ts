/**
 * Reading a committee set from `CommitteeRegistry` and turning it into QoreSeal
 * recipients a bidder can seal to.
 *
 * The registry stores, per member, the SHA3-256 of its ML-KEM key and the hash
 * of its recipient card, both signed by the member's ML-DSA-87 key on chain.
 * The cards themselves are in the `MemberJoined` events, and a copy ships with the
 * pages. A copy is used only where it matches the hash the registry holds, so a
 * wrong one is refused and the events are read instead. Then `resolveCommittee`
 * checks each member with the kit's `verifyMember`: ML-DSA key from the chain,
 * ML-KEM key from (possibly untrusted) REST against the signed hash, and the
 * card against its hash and both keys.
 */
import { isQoreSealError, type RecipientCard, type SealRecipient } from "@qorechain/qoreseal";
import { cardHash, verifyMember } from "qore-pq-kit/threshold";
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

/** A committee read from the chain, and where its cards came from. */
export interface ReadCommittee extends Committee {
  cardsFrom: "bundled" | "events";
  /** Members whose bundled card did not match the hash in the registry. */
  refused: number[];
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
  /**
   * A copy of the cards, e.g. deployments/committee-cards.json. Untrusted: each is
   * used only if its hash is the one the member signed into the registry, and
   * `resolveCommittee` checks it again with the member's keys. The logs are scanned
   * only when a card is missing or refused.
   */
  bundled?: Committee,
): Promise<ReadCommittee> {
  const [threshold, members] = await client.readContract({
    address: registry,
    abi: committeeRegistryAbi,
    functionName: "getSet",
    args: [setId],
  });
  const refused: number[] = [];
  // The copy is fetched JSON: check its shape before reading it.
  const usable = typeof bundled?.setId === "string" && bundled.setId.toLowerCase() === setId.toLowerCase() && Array.isArray(bundled.members);
  const copies = members.map((m, i) => {
    const card = usable ? bundled.members.find((x) => x?.index === i + 1)?.card : undefined;
    if (!card) return undefined;
    if (cardMatches(card, m.cardHash)) return card;
    refused.push(i + 1);
    return undefined;
  });
  const build = (cards: readonly (RecipientCard | undefined)[], cardsFrom: ReadCommittee["cardsFrom"]): ReadCommittee => ({
    setId,
    threshold: Number(threshold),
    members: members.map((m, i) => {
      const card = cards[i];
      if (!card) {
        const why = refused.includes(i + 1) ? " (its bundled card does not match the hash it signed on chain)" : "";
        throw new Error(`no MemberJoined event for member ${i + 1} of ${setId}${why}`);
      }
      return { index: i + 1, address: m.account, kemKeySha3: m.kemKeySha3, cardHash: m.cardHash, card };
    }),
    cardsFrom,
    refused,
  });
  if (copies.every((c) => c !== undefined)) return build(copies, "bundled");

  const logs = await collectLogs<{ args: { index: number; card: Hex } }>(
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
  ).catch(() => []);
  const events = new Map<number, Hex>();
  for (const l of logs) events.set(Number(l.args.index), l.args.card);
  return build(
    members.map((_, i) => (events.has(i + 1) ? cardFromBytes(events.get(i + 1)!) : copies[i])),
    "events",
  );
}

/** Does this card hash to what the member signed into the registry? Malformed cards do not. */
function cardMatches(card: RecipientCard, expected: Hex): boolean {
  try {
    return cardHash(card).toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

/** Check every member's three bindings and return the recipients, in share-index order. */
export async function resolveCommittee(
  committee: Committee,
  opts: { client: PublicClient; rest: string; sealChainId?: string; fetch?: typeof globalThis.fetch },
): Promise<SealRecipient[]> {
  return Promise.all(
    committee.members.map((m) =>
      verifyMember({
        address: m.address,
        expectKemSha3: m.kemKeySha3,
        card: m.card,
        expectCardHash: m.cardHash,
        sealChainId: opts.sealChainId ?? SEAL_CHAIN_ID,
        client: opts.client,
        rest: opts.rest,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
    ),
  );
}

/**
 * The bidder's whole check: read the committee (bundled cards first) and verify every
 * member. A bundled card can carry the right fields, and so the right hash, under a
 * broken signature; `resolveCommittee` refuses it, and the card is then read from the
 * chain and verified from the start. Nothing is accepted that did not pass every check.
 */
export async function checkCommittee(
  client: PublicClient,
  registry: Address,
  setId: Hex,
  opts: { rest: string; bundled?: Committee; sealChainId?: string; fetch?: typeof globalThis.fetch },
): Promise<{ committee: ReadCommittee; recipients: SealRecipient[] }> {
  const verify = async (bundled?: Committee) => {
    const committee = await readCommittee(client, registry, setId, undefined, bundled);
    return { committee, recipients: await resolveCommittee(committee, { client, ...opts }) };
  };
  try {
    return await verify(opts.bundled);
  } catch (err) {
    if (!opts.bundled || !isQoreSealError(err, "CARD_INVALID")) throw err;
    return verify();
  }
}
