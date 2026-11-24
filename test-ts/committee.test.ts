import { sealKeysFromSeed, signRecipientCard } from "@qorechain/qoreseal";
import { addressFromPublicKey, classicalKeyFromPrivate, pqKeyFromSeed } from "@qorechain/qoresign";
import { cardHash, kemKeySha3, qorAddress } from "qore-pq-kit/threshold";
import { describe, expect, it } from "vitest";
import { encodeFunctionResult, keccak256, parseAbi, toBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import { cardToBytes, checkCommittee, readCommittee, resolveCommittee, type Committee } from "../client/committee.ts";
import { SEAL_CHAIN_ID } from "../client/constants.ts";
import deployed from "../deployments/committee-cards.json" with { type: "json" };
import shipped from "../apps/web/public/committee-cards.testnet.json" with { type: "json" };

// Test-only members from fixed seeds. Never use these keys on a network.
const seed = (label: string) => toBytes(keccak256(toBytes(label)));
function member(i: number) {
  const classical = classicalKeyFromPrivate(seed(`psa/test/classical/${i}`), "eth_secp256k1");
  const addr = addressFromPublicKey(classical.publicKey, "eth_secp256k1");
  const pq = pqKeyFromSeed(seed(`psa/test/mldsa/${i}`));
  const keys = sealKeysFromSeed(seed(`psa/test/seal/${i}`));
  const card = signRecipientCard({ chainId: SEAL_CHAIN_ID, address: addr.bech32, keys, classicalKey: classical, pqKey: pq, issuedAt: "2026-11-16T00:00:00Z" });
  return { evm: addr.hex as Address, pq, keys, card, kemSha3: kemKeySha3(keys.mlkemPublicKey), cardHash: cardHash(card) };
}
const M = [member(1), member(2), member(3)];
const outsider = member(4);
const registry: Address = "0x1111111111111111111111111111111111111111";
const SET: Hex = `0x${"ab".repeat(32)}`;
const KEY_STATUS = parseAbi(["function pqcKeyStatus(address) view returns (bool, uint8, bytes, bool)"]);

/** A chain holding the true set: `getSet`, `pqcKeyStatus`, and the MemberJoined logs if it still has them. */
function chain(opts: { logs?: boolean } = {}) {
  const seen = { logReads: 0 };
  const client = {
    readContract: async () => [2, M.map((m) => ({ account: m.evm, kemKeySha3: m.kemSha3, cardHash: m.cardHash }))],
    getBlockNumber: async () => 20_000n,
    getContractEvents: async () => {
      seen.logReads++;
      return opts.logs === false ? [] : M.map((m, i) => ({ args: { index: i + 1, card: cardToBytes(m.card) } }));
    },
    call: async ({ data }: { data: Hex }) => {
      const m = M.find((x) => x.evm.slice(2).toLowerCase() === data.slice(-40).toLowerCase())!;
      return { data: encodeFunctionResult({ abi: KEY_STATUS, functionName: "pqcKeyStatus", result: [true, 1, toHex(m.pq.publicKey), true] }) };
    },
  } as unknown as PublicClient;
  return { client, seen };
}
/** REST with the true ML-KEM keys, or with member `lie`'s replaced by the outsider's. */
const rest = (lie?: number) =>
  (async (url: string) => {
    const addr = String(url).split("/").pop()!;
    const i = M.findIndex((m) => qorAddress(m.evm) === addr);
    const key = i === lie ? outsider.keys.mlkemPublicKey : M[i]!.keys.mlkemPublicKey;
    return new Response(JSON.stringify({ found: true, key: { address: addr, algorithm_id: 2, public_key: Buffer.from(key).toString("base64"), registered_height: "1" } }));
  }) as unknown as typeof fetch;

const bundle = (cards = M.map((m) => m.card), setId: Hex = SET): Committee => ({
  setId,
  threshold: 2,
  members: cards.map((card, i) => ({ index: i + 1, address: M[i]!.evm, kemKeySha3: M[i]!.kemSha3, cardHash: M[i]!.cardHash, card })),
});
const check = (c: PublicClient, bundled?: Committee, f = rest()) => checkCommittee(c, registry, SET, { rest: "https://rest.invalid", bundled, fetch: f });

/** A card that swaps in the outsider's X25519 key, keeping the member's signature. */
const tampered = { ...M[0]!.card, x25519PublicKey: outsider.card.x25519PublicKey };

describe("bundled committee cards", () => {
  it("right cards are used without reading a single log, and every member still verifies", async () => {
    const { client, seen } = chain();
    const { committee, recipients } = await check(client, bundle());
    expect(committee.cardsFrom).toBe("bundled");
    expect(committee.refused).toEqual([]);
    expect(seen.logReads).toBe(0);
    expect(recipients.map((r) => toHex(r.mlkemPublicKey))).toEqual(M.map((m) => toHex(m.keys.mlkemPublicKey)));
  });

  it("without a bundle the cards come from the logs", async () => {
    const { client, seen } = chain();
    expect((await check(client)).committee.cardsFrom).toBe("events");
    expect(seen.logReads).toBeGreaterThan(0);
  });

  it.each([
    ["a tampered card", [tampered, M[1]!.card, M[2]!.card]],
    ["another member's card", [M[1]!.card, M[1]!.card, M[2]!.card]],
    ["an outsider's validly signed card", [outsider.card, M[1]!.card, M[2]!.card]],
    ["a malformed card", [{ nonsense: true } as never, M[1]!.card, M[2]!.card]],
  ])("%s is refused, and the chain's own card is used instead", async (_what, cards) => {
    const { client, seen } = chain();
    const { committee, recipients } = await check(client, bundle(cards));
    expect(committee.refused).toEqual([1]);
    expect(committee.cardsFrom).toBe("events");
    expect(seen.logReads).toBeGreaterThan(0);
    expect(committee.members[0]!.card).toEqual(M[0]!.card);
    expect(toHex(recipients[0]!.x25519PublicKey!)).toBe(toHex(M[0]!.keys.x25519PublicKey));
  });

  it("a wrong card with no logs to fall back on fails the check; it is never used", async () => {
    const { client } = chain({ logs: false });
    await expect(check(client, bundle([tampered, M[1]!.card, M[2]!.card]))).rejects.toThrow(/does not match the hash it signed on chain/);
  });

  it("a bundle that rewrites its own hashes and addresses to match is still refused: the registry's are used", async () => {
    const { client } = chain({ logs: false });
    const b = bundle([outsider.card, M[1]!.card, M[2]!.card]);
    b.members[0] = { index: 1, address: outsider.evm, kemKeySha3: outsider.kemSha3, cardHash: outsider.cardHash, card: outsider.card };
    await expect(check(client, b)).rejects.toThrow(/does not match the hash it signed on chain/);
  });

  it("a bundle for another committee set, or one that is not a committee, is ignored", async () => {
    for (const b of [bundle(undefined, `0x${"cd".repeat(32)}`), {} as Committee, { setId: SET, members: "x" } as unknown as Committee]) {
      expect((await readCommittee(chain().client, registry, SET, undefined, b)).cardsFrom).toBe("events");
    }
  });

  it("a card with the right hash but a broken signature is refused, and the chain's card is verified instead", async () => {
    const bad = { ...M[0]!.card, signature: M[1]!.card.signature };
    expect(cardHash(bad)).toBe(M[0]!.cardHash);
    const { client } = chain();
    await expect(resolveCommittee(await readCommittee(client, registry, SET, undefined, bundle([bad, M[1]!.card, M[2]!.card])), { client, rest: "https://rest.invalid", fetch: rest() })).rejects.toThrow();
    expect((await check(client, bundle([bad, M[1]!.card, M[2]!.card]))).committee.cardsFrom).toBe("events");
    await expect(check(chain({ logs: false }).client, bundle([bad, M[1]!.card, M[2]!.card]))).rejects.toThrow();
  });

  it("right cards do not excuse a lying REST proxy", async () => {
    await expect(check(chain().client, bundle(), rest(1))).rejects.toThrow(/ML-KEM/);
  });

  it("the shipped testnet cards are the recorded ones, and each hashes to what its member signed", () => {
    expect(shipped).toEqual(deployed);
    for (const m of shipped.members) expect(cardHash(m.card as never)).toBe(m.cardHash);
  });
});
