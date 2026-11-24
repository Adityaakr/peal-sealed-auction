import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { candidates, escrowChoice, escrowLadder, escrowNeeded, roundUp } from "../client/escrow.ts";

const D = 18;
const u = (v: string) => parseUnits(v, D);
/** The open demo auction: 50 fUSD (6 decimals) for PEAL-T, limits 0.50 to 2.25 in 8 steps. */
const demo = { reservePrice: u("0.5"), tickSize: u("0.25"), numTicks: 8, saleDecimals: 6, totalSupply: parseUnits("50", 6) };
const all = candidates(demo, () => true);
const most = escrowNeeded(demo, demo.totalSupply, demo.numTicks - 1);

describe("escrow", () => {
  it("matches the contract's rule: quantity x limit, rounded up, never 0", () => {
    expect(escrowNeeded(demo, parseUnits("3", 6), 4)).toBe(u("4.5")); // the hosted test's bid #3
    expect(escrowNeeded(demo, parseUnits("6", 6), 3)).toBe(u("7.5")); // and #4
    expect(escrowNeeded({ reservePrice: 1n, tickSize: 0n, saleDecimals: 18 }, 1n, 0)).toBe(1n);
    expect(escrowNeeded({ reservePrice: 3n, tickSize: 0n, saleDecimals: 1 }, 5n, 0)).toBe(2n); // 1.5 rounds up
    expect(escrowNeeded({ reservePrice: 0n, tickSize: 1n, saleDecimals: 18 }, 5n, 0)).toBe(1n); // the contract refuses 0
  });

  it("rounds up to 10, 25, 50, 100, 250, 500, ...", () => {
    for (const [need, bucket] of [["0.000001", "10"], ["10", "10"], ["10.000001", "25"], ["25", "25"], ["26", "50"], ["50.5", "100"], ["100.1", "250"], ["251", "500"], ["501", "1000"], ["1001", "2500"]] as const) {
      expect(roundUp(u(need), D)).toBe(u(bucket));
    }
    expect(roundUp(parseUnits("7.5", 6), 6)).toBe(parseUnits("10", 6));
  });

  it("an auction's buckets end at its largest possible bid, with no thin bucket below it", () => {
    expect(most).toBe(u("112.5"));
    expect(escrowLadder(most, D)).toEqual([u("10"), u("25"), u("50"), u("112.5")]);
    expect(escrowLadder(u("12"), D)).toEqual([u("12")]);
    const choose = (mode: "bucket" | "wider" | "cover-all" | "exact", need: string) => escrowChoice(mode, u(need), most, D);
    expect(choose("bucket", "4.5")).toBe(u("10"));
    expect(choose("wider", "4.5")).toBe(u("25"));
    expect(choose("bucket", "60")).toBe(u("112.5"));
    expect(choose("wider", "60")).toBe(u("112.5"));
    expect(choose("cover-all", "4.5")).toBe(u("112.5"));
    expect(choose("exact", "4.5")).toBe(u("4.5"));
    expect(choose("bucket", "120")).toBe(u("250")); // more than the whole supply
  });

  it("every choice covers the bid, so the contract never excludes it for a short escrow", () => {
    for (const b of all) {
      const need = escrowNeeded(demo, b.quantity, b.tick);
      for (const mode of ["bucket", "wider", "cover-all", "exact"] as const) expect(escrowChoice(mode, need, most, D)).toBeGreaterThanOrEqual(need);
    }
  });

  it("measured on the demo auction: what one public escrow leaves an observer guessing (whole-fUSD bids)", () => {
    expect(all.length).toBe(400);
    const left = (mode: "exact" | "bucket" | "cover-all") =>
      all
        .map((b) => {
          const mine = escrowChoice(mode, escrowNeeded(demo, b.quantity, b.tick), most, D);
          return candidates(demo, (need) => escrowChoice(mode, need, most, D) === mine).length;
        })
        .sort((a, b) => a - b);
    const stats = (xs: number[]) => ({ min: xs[0], median: xs[xs.length >> 1], max: xs[xs.length - 1] });
    const perBucket = Object.fromEntries(["10", "25", "50", "112.5"].map((b) => [b, candidates(demo, (need) => escrowChoice("bucket", need, most, D) === u(b)).length]));
    expect({ exact: stats(left("exact")), bucket: stats(left("bucket")), coverAll: stats(left("cover-all")), perBucket }).toMatchInlineSnapshot(`
      {
        "bucket": {
          "max": 117,
          "median": 110,
          "min": 71,
        },
        "coverAll": {
          "max": 400,
          "median": 400,
          "min": 400,
        },
        "exact": {
          "max": 6,
          "median": 2,
          "min": 1,
        },
        "perBucket": {
          "10": 71,
          "112.5": 102,
          "25": 110,
          "50": 117,
        },
      }
    `);
  });
});
