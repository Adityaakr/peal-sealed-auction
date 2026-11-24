/**
 * Envelopes of bids a vault makes over the smart-account lane: they are only in the
 * calldata of a `MsgExecuteEVM` sent to the vault, and the vault is the bidder.
 */
import { generateSealKeys, recipientOf, type SealKeyPair } from "@qorechain/qoreseal";
import { bech32 } from "@scure/base";
import { combine, openSlot } from "qore-pq-kit/threshold";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, hexToBytes, type Address, type Hex, type PublicClient } from "viem";
import { sealedAuctionAbi } from "../client/abi.ts";
import { sealBid } from "../client/bid.ts";
import { decodePlaintext } from "../client/plaintext.ts";
import { MAX_VAULT_CANDIDATES, bidderVaultAbi, executeEvmBids, openMemberShares, readBids, type CommittedBid } from "../client/release.ts";

const chainId = 9800n;
const auction = getAddress("0x1111111111111111111111111111111111111111");
const otherAuction = getAddress("0x1212121212121212121212121212121212121212");
const vault = getAddress("0x5555555555555555555555555555555555555555");
const owner = getAddress("0x2222222222222222222222222222222222222222");
const stranger = getAddress("0x3333333333333333333333333333333333333333");

const START = 1_764_000_000;
const members: SealKeyPair[] = [generateSealKeys(), generateSealKeys(), generateSealKeys()];
const recipients = members.map((k) => recipientOf(k));

type Sealed = ReturnType<typeof sealBid>;
type Msg = Record<string, unknown>;
const seal = (bidder: Address, seq = 0n): Sealed => sealBid({ chainId, auction, bidder, seq, quantity: 1234n, tick: 5, recipients, threshold: 2 });
const b64 = (hex: Hex) => Buffer.from(hexToBytes(hex)).toString("base64");
const qor = (a: Address) => bech32.encode("qor", bech32.toWords(hexToBytes(a)));
const execute = (account: Address, to: string, data: string): Msg => ({ "@type": "/qorechain.abstractaccount.v1.MsgExecuteEVM", account: qor(account), to, data });
const bidCall = (c: Sealed, seq = 0, over: { auction?: Address; envelopes?: Hex[] } = {}): Hex =>
  encodeFunctionData({ abi: bidderVaultAbi, functionName: "bid", args: [over.auction ?? auction, seq, c.ct, c.keyHash, c.shareHashes, over.envelopes ?? c.envelopes, 5n] });
const viaVault = (c: Sealed, over: { to?: string; account?: Address; seq?: number; auction?: Address; envelopes?: Hex[] } = {}): Msg =>
  execute(over.account ?? owner, over.to ?? vault.toLowerCase(), b64(bidCall(c, over.seq, over)));
const direct = (c: Sealed, account: Address, seq = 0): Msg =>
  execute(account, auction.toLowerCase(), b64(encodeFunctionData({ abi: sealedAuctionAbi, functionName: "commitBid", args: [seq, c.ct, c.keyHash, c.shareHashes, c.envelopes, 5n] })));

const failure = (index?: number) => ({ type: "abstractaccount_execution_failed", attributes: index === undefined ? [] : [{ key: "msg_index", value: String(index) }] });
const row = (messages: Msg[], o: { code?: number; events?: unknown[]; at?: number } = {}) => ({
  code: o.code ?? 0,
  events: o.events ?? [{ type: "message" }],
  timestamp: new Date((o.at ?? START + 100) * 1000).toISOString(),
  tx: { body: { messages } },
});
type Row = ReturnType<typeof row>;
const noise = (n: number, at?: number): Row[] => Array.from({ length: n }, () => row([execute(stranger, stranger, b64("0xdeadbeef"))], { at }));

/** The REST search as the node answers it: 100 rows a page, newest first, HTTP 500 past the end. */
function node(rows: Row[], fail: (page: number, attempt: number) => boolean = () => false) {
  const asked: number[] = [];
  const fetch = (async (url: string) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get("page"));
    asked.push(page);
    if (fail(page, asked.filter((p) => p === page).length)) return new Response("busy", { status: 503 });
    const pages = Math.max(1, Math.ceil(rows.length / 100));
    if (page > pages) return new Response(JSON.stringify({ message: `page should be within [1, ${pages}] range, given ${page}` }), { status: 500 });
    return new Response(JSON.stringify({ total: String(rows.length), tx_responses: rows.slice((page - 1) * 100, page * 100) }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

interface OnChain {
  bidder: Address;
  seq: bigint;
  c: Sealed;
  /** The commit's event log, where the RPC has one (the EVM lane). */
  logged?: boolean;
}

/** Contract storage, and the logs the JSON-RPC indexes. */
function chain(bids: OnChain[]): PublicClient {
  return {
    readContract: async ({ functionName, args }: { functionName: string; args?: [bigint] }) => {
      if (functionName === "bidCount") return bids.length;
      if (functionName === "config") return { startTime: BigInt(START) };
      const b = bids[Number(args![0])]!;
      if (functionName === "shareHashesOf") return b.c.shareHashes;
      return { bidder: b.bidder, seq: Number(b.seq), ct: b.c.ct, keyHash: b.c.keyHash, escrow: 5n };
    },
    getBlock: async () => ({ timestamp: BigInt(START + 1_000) }),
    getBlockNumber: async () => 5_000n,
    getContractEvents: async () => bids.flatMap((b, i) => (b.logged ? [{ args: { bidId: BigInt(i), envelopes: b.c.envelopes } }] : [])),
  } as unknown as PublicClient;
}

const read = (bids: OnChain[], n: { fetch: typeof globalThis.fetch }) => readBids(chain(bids), auction, { rest: "http://rest", fetch: n.fetch });
const release = (bids: CommittedBid[]) => members.map((keys, i) => openMemberShares({ chainId, auction, index: i + 1, keys, bids }));
/** Which bids each of the three members would flag. */
const flags = (bids: CommittedBid[]) => release(bids).map((r) => r.invalidBitmap);

describe("a vault bid over the smart-account lane", () => {
  it("every member opens its share, and two rebuild the bid", async () => {
    const c = seal(vault);
    const bids = await read([{ bidder: vault, seq: 0n, c }], node([row([viaVault(c)])]));
    const r = release(bids);
    expect(r.map((x) => x.invalidBitmap)).toEqual([0n, 0n, 0n]);
    const shares = [0, 2].map((m) => ({ index: m + 1, value: r[m]!.shares[0]! }));
    expect(combine(shares)).not.toBe(0n);
    expect(decodePlaintext(openSlot({ chainId, app: auction, sender: vault, seq: 0n }, shares, c.keyHash, c.ct))).toEqual({ quantity: 1234n, tick: 5, padded: true });
  });

  it("the bond-burn trap: without the vault's calldata all three members flag the bid", async () => {
    const bids = await read([{ bidder: vault, seq: 0n, c: seal(vault) }], node(noise(3)));
    expect(flags(bids)).toEqual([1n, 1n, 1n]);
    expect(release(bids)[0]!.invalid[0]!.reason).toBe("no envelope found for this bid");
  });

  it("is keyed by the vault and seq, whoever sent the message", async () => {
    const [a, b] = [seal(vault, 0n), seal(vault, 1n)];
    const bids = await read(
      [
        { bidder: vault, seq: 0n, c: a },
        { bidder: vault, seq: 1n, c: b },
      ],
      node([row([viaVault(b, { seq: 1, account: stranger })]), row([viaVault(a, { to: vault })])]), // a checksummed target too
    );
    expect(flags(bids)).toEqual([0n, 0n, 0n]);
  });

  it("a bid sealed to the owner instead of the vault stays flagged", async () => {
    const c = seal(owner);
    expect(flags(await read([{ bidder: vault, seq: 0n, c }], node([row([viaVault(c)])])))).toEqual([1n, 1n, 1n]);
  });

  it("selector and layout are the vault's bid(address,uint32,bytes32,bytes32,bytes32[],bytes[],uint256)", () => {
    expect(bidCall(seal(vault)).slice(0, 10)).toBe("0xfc4c422a");
  });
});

describe("calls that are not this auction's bid", () => {
  const c = seal(vault);
  const bid = [{ bidder: vault, seq: 0n, c }];
  const good = bidCall(c);
  const cases: [string, Row][] = [
    ["another auction", row([viaVault(c, { auction: otherAuction })])],
    ["another seq", row([viaVault(c, { seq: 1 })])],
    ["another vault", row([viaVault(c, { to: stranger })])],
    ["a transaction that failed", row([viaVault(c)], { code: 5 })],
    ["an execution that failed", row([viaVault(c)], { events: [failure(0)] })],
    ["a failure that names no message", row([viaVault(c)], { events: [failure()] })],
    ["truncated calldata", row([execute(owner, vault, b64(good.slice(0, 400) as Hex))])],
    ["an offset out of range", row([execute(owner, vault, b64((good.slice(0, 10 + 64 * 4) + "ff".repeat(32) + good.slice(10 + 64 * 5)) as Hex))])],
    ["the selector alone", row([execute(owner, vault, b64(good.slice(0, 10) as Hex))])],
    ["data that is not base64", row([execute(owner, vault, "***")])],
    ["oversized calldata", row([execute(owner, vault, b64(`${good}${"00".repeat(60_000)}`))])],
    ["a target that is not an address", row([execute(owner, "qor1vault", b64(good))])],
    ["no data", row([{ "@type": "/qorechain.abstractaccount.v1.MsgExecuteEVM", account: qor(owner), to: vault }])],
    ["another message type", row([{ ...viaVault(c), "@type": "/cosmos.bank.v1beta1.MsgSend" }])],
    ["wrapped in an authz MsgExec", row([{ "@type": "/cosmos.authz.v1beta1.MsgExec", msgs: [viaVault(c)] }])],
    ["wrapped in another contract call", row([execute(owner, vault, b64(`0xac9650d8${good.slice(2)}`))])],
    ["other share hashes", row([viaVault({ ...c, shareHashes: seal(vault).shareHashes })])],
    ["another ct", row([viaVault({ ...c, ct: seal(vault).ct })])],
    ["another keyHash", row([viaVault({ ...c, keyHash: seal(vault).keyHash })])],
    ["too few envelopes", row([viaVault(c, { envelopes: c.envelopes.slice(0, 2) })])],
    ["an empty envelope", row([viaVault(c, { envelopes: ["0x", ...c.envelopes.slice(1)] })])],
    ["an envelope over the contract's limit", row([viaVault(c, { envelopes: [`0x${"00".repeat(4097)}`, ...c.envelopes.slice(1)] })])],
  ];
  it.each(cases)("%s: ignored", async (_, r) => {
    const bids = await read(bid, node([r]));
    expect(bids[0]!.envelopes).toEqual([]);
  });

  it("none of them hides the real bid", async () => {
    const bids = await read(bid, node([...cases.map(([, r]) => r), row([viaVault(c)]), ...cases.map(([, r]) => r)]));
    expect(flags(bids)).toEqual([0n, 0n, 0n]);
  });

  it("a multi-message transaction: only the message that failed is dropped", async () => {
    const d = seal(vault, 1n);
    const both = [
      { bidder: vault, seq: 0n, c },
      { bidder: vault, seq: 1n, c: d },
    ];
    const msgs = [viaVault(c), viaVault(d, { seq: 1 })];
    expect(flags(await read(both, node([row(msgs)])))).toEqual([0n, 0n, 0n]);
    expect(flags(await read(both, node([row(msgs, { events: [failure(1)] })])))).toEqual([2n, 2n, 2n]);
  });
});

describe("imitations of a vault bid", () => {
  const c = seal(vault);
  const bid = [{ bidder: vault, seq: 0n, c }];
  const junk = (n: number) => Array.from({ length: 3 }, (_, j) => `0x${(n * 3 + j + 1).toString(16).padStart(4, "0").repeat(876)}` as Hex);
  const fake = (n: number) => row([viaVault(c, { account: stranger, envelopes: junk(n) })]);

  it("junk envelopes under the real public hashes, before and after it, do not get the bid flagged", async () => {
    expect(flags(await read(bid, node([fake(1), fake(2), row([viaVault(c)]), fake(3)])))).toEqual([0n, 0n, 0n]);
  });

  it("a flood of later copies does not push the real bid out, and the sets tried are bounded", async () => {
    const flood = Array.from({ length: 250 }, (_, i) => fake(i + 1));
    const bids = await read(bid, node([...flood, row([viaVault(c)])]));
    expect(1 + bids[0]!.alternates!.length).toBe(MAX_VAULT_CANDIDATES);
    expect(flags(bids)).toEqual([0n, 0n, 0n]);
  });

  it("the same call repeated is one candidate", async () => {
    const bids = await read(bid, node([row([viaVault(c)]), row([viaVault(c)])]));
    expect(bids[0]!.alternates).toBeUndefined();
  });

  it("only junk: the bid is flagged, with the reason its first set failed", async () => {
    const bids = await read(bid, node([fake(1), fake(2)]));
    expect(flags(bids)).toEqual([1n, 1n, 1n]);
    expect(release(bids)[0]!.invalid[0]!.reason).not.toBe("no envelope found for this bid");
  });

  it("a bid(...) sent to an ordinary bidder's address never replaces its own commitBid", async () => {
    const d = seal(stranger);
    const decoy = row([viaVault(d, { to: stranger, account: owner, envelopes: junk(9) })]);
    for (const rows of [
      [decoy, row([direct(d, stranger)])],
      [row([direct(d, stranger)]), decoy],
    ]) {
      const bids = await read([{ bidder: stranger, seq: 0n, c: d }], node(rows));
      expect(bids[0]!.envelopes).toEqual(d.envelopes);
      expect(bids[0]!.alternates).toBeUndefined();
      expect(flags(bids)).toEqual([0n, 0n, 0n]);
    }
  });
});

describe("existing bids", () => {
  it("every lane in one auction: EVM logs, commitBid from a smart account, and a vault", async () => {
    const [evm, acct, vlt] = [seal(stranger), seal(owner), seal(vault)];
    const bids = await read(
      [
        { bidder: stranger, seq: 0n, c: evm, logged: true },
        { bidder: owner, seq: 0n, c: acct },
        { bidder: vault, seq: 0n, c: vlt },
      ],
      node([...noise(5), row([viaVault(vlt)]), row([direct(acct, owner)]), ...noise(5)]),
    );
    expect(bids.map((b) => b.envelopes)).toEqual([evm.envelopes, acct.envelopes, vlt.envelopes]);
    expect(flags(bids)).toEqual([0n, 0n, 0n]);
  });

  it("with every envelope in the logs, a vault's included, REST is never asked", async () => {
    const n = node([]);
    const c = seal(vault);
    expect(flags(await read([{ bidder: vault, seq: 0n, c, logged: true }], n))).toEqual([0n, 0n, 0n]);
    expect(n.asked).toEqual([]);
  });

  it("a smart account's commitBid in a transaction with any failure is still skipped", async () => {
    const c = seal(owner);
    const bids = await read([{ bidder: owner, seq: 0n, c }], node([row([direct(c, owner), execute(owner, stranger, b64("0xdeadbeef"))], { events: [failure(1)] })]));
    expect(bids[0]!.envelopes).toEqual([]);
  });
});

describe("the search's bounds", () => {
  const c = seal(vault);
  const bid = [{ bidder: vault, seq: 0n, c }];

  it("finds a bid far past the old ten-page limit", async () => {
    const n = node([...noise(2_350), row([viaVault(c)])]);
    expect(flags(await read(bid, n))).toEqual([0n, 0n, 0n]);
    expect(n.asked.length).toBe(24);
  });

  it("stops at the start of bidding", async () => {
    const n = node([...noise(150), row([viaVault(c)]), ...noise(5_000, START - 10)]);
    expect(flags(await read(bid, n))).toEqual([0n, 0n, 0n]);
    expect(n.asked).toEqual([1, 2]);
  });

  it("reads exactly the pages there are", async () => {
    for (const [rows, pages] of [[100, 1], [101, 2], [200, 2]] as const) {
      const n = node(noise(rows));
      await executeEvmBids("http://rest", auction, { fetch: n.fetch });
      expect(n.asked.length).toBe(pages);
    }
  });

  it("never reads more than maxPages", async () => {
    const n = node(noise(1_000));
    await executeEvmBids("http://rest", auction, { fetch: n.fetch, maxPages: 3 });
    expect(n.asked).toEqual([1, 2, 3]);
  });

  it("past the last page (HTTP 500) is the end, not an error", async () => {
    const n = node(noise(100));
    const noTotal = (async (u: string) => {
      const r = await n.fetch(u);
      if (!r.ok) return r;
      const { tx_responses } = (await r.json()) as { tx_responses: unknown };
      return new Response(JSON.stringify({ tx_responses }));
    }) as unknown as typeof globalThis.fetch;
    expect(await executeEvmBids("http://rest", auction, { fetch: noTotal })).toEqual([]);
    expect(n.asked).toEqual([1, 2]);
  });

  it("a busy node is retried", async () => {
    const n = node([...noise(120), row([viaVault(c)])], (page, attempt) => page === 2 && attempt === 1);
    const found = await executeEvmBids("http://rest", auction, { fetch: n.fetch, retryMs: 0 });
    expect(found.length).toBe(1);
  });

  it("an unreadable page stops the member instead of getting the bid flagged", async () => {
    const n = node([...noise(120), row([viaVault(c)])], (page) => page === 2);
    await expect(read(bid, n)).rejects.toThrow(/failed at page 2: HTTP 503/);
  });
});
