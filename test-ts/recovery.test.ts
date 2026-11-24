import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, hexToBytes, type PublicClient } from "viem";
import { sealedAuctionAbi } from "../client/abi.ts";
import { collectLogs, lowestAvailable } from "../client/logs.ts";
import { recordedReleases } from "../client/recorded.ts";
import { envelopesFromExecuteEvm } from "../client/release.ts";

const auction = getAddress("0x481fbb2c84582bf7c258c46bf523deebde51e990");
const bidder = getAddress("0xaCdB2d02220FAf6e17B5bdA53DDd90B46d9426BA");
const qor = bech32.encode("qor", bech32.toWords(hexToBytes(bidder)));
const b64 = (hex: `0x${string}`) => Buffer.from(hexToBytes(hex)).toString("base64");

function commitData(seq: number, tag: number) {
  return encodeFunctionData({
    abi: sealedAuctionAbi,
    functionName: "commitBid",
    args: [seq, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, [`0x${"33".repeat(32)}`], [`0x${tag.toString(16).padStart(2, "0").repeat(4)}`], 5n],
  });
}

function tx(to: string, data: `0x${string}`, failed = false, code = 0) {
  return {
    code,
    events: failed ? [{ type: "abstractaccount_execution_failed" }] : [{ type: "message" }],
    tx: { body: { messages: [{ "@type": "/qorechain.abstractaccount.v1.MsgExecuteEVM", account: qor, to, data: b64(data) }] } },
  };
}

describe("envelopes from MsgExecuteEVM calldata", () => {
  it("decodes commitBid envelopes for this auction only, skipping failed executions", async () => {
    const responses = [
      tx(auction.toLowerCase(), commitData(0, 0xaa)),
      tx(auction.toLowerCase(), commitData(1, 0xbb), true), // execution failed: no bid
      tx("0x0000000000000000000000000000000000000001", commitData(2, 0xcc)), // another contract
      tx(auction.toLowerCase(), encodeFunctionData({ abi: sealedAuctionAbi, functionName: "closeCommit" })), // not a commit
    ];
    const fetch = (async () => new Response(JSON.stringify({ tx_responses: responses }))) as typeof globalThis.fetch;
    const m = await envelopesFromExecuteEvm("http://rest", auction, fetch);
    expect([...m.keys()]).toEqual([`${bidder.toLowerCase()}:0`]);
    expect(m.get(`${bidder.toLowerCase()}:0`)).toEqual(["0xaaaaaaaa"]);
  });
});

describe("log scans on a pruned node", () => {
  it("reads the error's lowest height", () => {
    const e = new Error("failed to fetch block result from CometBFT 8788467: height 8788467 is not available, lowest height is 8790799");
    expect(lowestAvailable(e)).toBe(8790799n);
    expect(lowestAvailable(new Error("other"))).toBeUndefined();
  });

  it("clamps a backwards scan to the lowest available height and stops", async () => {
    const client = { getBlockNumber: async () => 8_800_000n } as unknown as PublicClient;
    const asked: [bigint, bigint][] = [];
    const out = await collectLogs(
      client,
      async (from, to) => {
        asked.push([from, to]);
        if (from < 8_795_000n) throw new Error(`height ${from} is not available, lowest height is 8795000`);
        return [from];
      },
      5,
    );
    expect(asked).toEqual([
      [8_790_001n, 8_800_000n],
      [8_795_000n, 8_800_000n],
    ]);
    expect(out).toEqual([8_795_000n]);
  });
});

describe("recorded blocks", () => {
  const client = { getBlockNumber: async () => 30_000n } as unknown as PublicClient;
  const reader = (at: bigint[]) => {
    const asked: [bigint, bigint][] = [];
    return { asked, read: async (from: bigint, to: bigint) => (asked.push([from, to]), at.filter((b) => b >= from && b <= to)) };
  };

  it("reads only the recorded range when it holds every event", async () => {
    const r = reader([105n, 110n]);
    expect(await collectLogs(client, r.read, 2, { recorded: { from: 100n, to: 120n } })).toEqual([105n, 110n]);
    expect(r.asked).toEqual([[100n, 120n]]);
  });

  it("a wrong, short or unreadable range costs one read: the scan still finds every event, once", async () => {
    for (const recorded of [{ from: 1n, to: 2n }, { from: 100n, to: 106n }]) {
      expect(await collectLogs(client, reader([105n, 110n]).read, 2, { recorded })).toEqual([105n, 110n]);
    }
    const r = reader([105n]);
    const flaky = async (from: bigint, to: bigint) => {
      if (from === 100n) throw new Error("node busy");
      return r.read(from, to);
    };
    expect(await collectLogs(client, flaky, 1, { recorded: { from: 100n, to: 120n } })).toEqual([105n]);
  });

  it("every recorded range fits one log query, and belongs to this chain only", () => {
    for (const a of ["0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124", "0x9A98Fc3b3B5078Bd22bAE5fb937395Ba1AE8c7B4", "0xd919F252cD684AF3822DF42F160BAeDf61DCDF68"] as const) {
      const r = recordedReleases(9800n, a)!;
      expect(r.to - r.from >= 0n && r.to - r.from < 10_000n).toBe(true);
      expect(recordedReleases(31337n, a)).toBeUndefined();
    }
  });
});
