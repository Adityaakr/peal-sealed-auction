import { generateSealKeys, recipientOf, type SealKeyPair } from "@qorechain/qoreseal";
import { pqcVerify } from "@qorechain/sdk";
import { pqKeyFromSeed } from "@qorechain/qoresign";
import { combine, openSlot } from "qore-pq-kit/threshold";
import { describe, expect, it } from "vitest";
import { getAddress, hexToBytes, keccak256, toBytes, type Address } from "viem";
import { sealBid } from "../client/bid.ts";
import { decodePlaintext, encodePlaintext } from "../client/plaintext.ts";
import { openMemberShares, signRelease, type CommittedBid } from "../client/release.ts";

const chainId = 9800n;
const auction = getAddress("0x1111111111111111111111111111111111111111");
const bidder = getAddress("0x2222222222222222222222222222222222222222");
const other = getAddress("0x3333333333333333333333333333333333333333");

const members: SealKeyPair[] = [generateSealKeys(), generateSealKeys(), generateSealKeys()];
const recipients = members.map((k) => recipientOf(k));

function commit(bidId: bigint, who: Address, seq: bigint, quantity: bigint, tick: number): CommittedBid {
  const c = sealBid({ chainId, auction, bidder: who, seq, quantity, tick, recipients, threshold: 2 });
  return { bidId, bidder: who, seq, ct: c.ct, keyHash: c.keyHash, shareHashes: c.shareHashes, envelopes: c.envelopes, escrow: 1n };
}

describe("plaintext", () => {
  it("matches the contract layout", () => {
    expect(encodePlaintext(1234n, 5)).toBe("0x000000000000000000000000000004d200050000000000000000000000000000");
    const d = decodePlaintext(encodePlaintext(10n ** 20n, 255));
    expect(d).toEqual({ quantity: 10n ** 20n, tick: 255, padded: true });
    expect(() => encodePlaintext(0n, 1)).toThrow();
    expect(() => encodePlaintext(1n, 70000)).toThrow();
  });
});

describe("sealing and releasing", () => {
  const bids = [commit(0n, bidder, 0n, 50n * 10n ** 18n, 2), commit(1n, bidder, 1n, 7n, 0), commit(2n, other, 0n, 99n, 7)];

  it("each member opens only its own share, and any two rebuild every bid", () => {
    const r = members.map((keys, i) => openMemberShares({ chainId, auction, index: i + 1, keys, bids }));
    for (const x of r) expect(x.invalidBitmap).toBe(0n);
    for (const pair of [[0, 1], [0, 2], [1, 2]] as const) {
      for (const b of bids) {
        const shares = pair.map((m) => ({ index: m + 1, value: r[m]!.shares[Number(b.bidId)]! }));
        const pt = openSlot({ chainId, app: auction, sender: b.bidder, seq: b.seq }, shares, b.keyHash, b.ct);
        expect(decodePlaintext(pt).padded).toBe(true);
      }
    }
    const pt0 = openSlot(
      { chainId, app: auction, sender: bidder, seq: 0n },
      [{ index: 1, value: r[0]!.shares[0]! }, { index: 3, value: r[2]!.shares[0]! }],
      bids[0]!.keyHash,
      bids[0]!.ct,
    );
    expect(decodePlaintext(pt0)).toEqual({ quantity: 50n * 10n ** 18n, tick: 2, padded: true });
  });

  it("one share alone does not give the key", () => {
    const r = openMemberShares({ chainId, auction, index: 1, keys: members[0]!, bids });
    const k = combine([{ index: 1, value: r.shares[0]! }]);
    expect(() =>
      openSlot({ chainId, app: auction, sender: bidder, seq: 0n }, [{ index: 1, value: r.shares[0]! }], bids[0]!.keyHash, bids[0]!.ct),
    ).toThrow(/keyHash/);
    expect(k).not.toBe(0n);
  });

  it("an outsider's keys open nothing: every bid is flagged", () => {
    const r = openMemberShares({ chainId, auction, index: 1, keys: generateSealKeys(), bids });
    expect(r.invalidBitmap).toBe(0b111n);
    expect(r.shares).toEqual([0n, 0n, 0n]);
  });

  it("an envelope copied under another bidder or seq is flagged (AAD binds it)", () => {
    const copied: CommittedBid[] = [{ ...bids[0]!, bidder: other }, { ...bids[0]!, bidId: 1n, seq: 5n }];
    const r = openMemberShares({ chainId, auction, index: 1, keys: members[0]!, bids: copied });
    expect(r.invalidBitmap).toBe(0b11n);
  });

  it("a share that does not match its committed hash is flagged", () => {
    const tampered: CommittedBid[] = [{ ...bids[0]!, shareHashes: [keccak256(toBytes("x")), ...bids[0]!.shareHashes.slice(1)] }];
    const r = openMemberShares({ chainId, auction, index: 1, keys: members[0]!, bids: tampered });
    expect(r.invalidBitmap).toBe(1n);
  });

  it("envelopes are the expected QoreSeal size", () => {
    expect(hexToBytes(bids[0]!.envelopes[0]!).length).toBe(1752);
  });
});

describe("release signature", () => {
  it("is ML-DSA-87 and checked locally", () => {
    const pq = pqKeyFromSeed(new Uint8Array(32).fill(7));
    const msg = `0x${"ab".repeat(256)}` as const;
    const sig = signRelease(pq, msg);
    expect(hexToBytes(sig).length).toBe(4627);
    expect(pqcVerify(pq.publicKey, hexToBytes(msg), hexToBytes(sig))).toBe(true);
    const wrong = pqKeyFromSeed(new Uint8Array(32).fill(8));
    expect(() => signRelease({ secretKey: pq.secretKey, publicKey: wrong.publicKey }, msg)).toThrow(/local/);
  });
});
