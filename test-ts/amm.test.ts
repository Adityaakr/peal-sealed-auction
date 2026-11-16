import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { amountInFor, amountOut, ammRegistry, bankDenomOf, buyMessages, findPool, quoteBuy, type Pool } from "../client/amm.ts";

const FUSD = getAddress("0x97143B771D34ddb9130b807b135Ae675A5a963CA");
const fusd = bankDenomOf(FUSD);
// The testnet's pools as read on 17 November 2026 (reserves shortened for pool 3).
const pools: Pool[] = [
  { id: "1", pool_type: "constant_product", token_a: "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28", token_b: "uqor", reserve_a: "979164", reserve_b: "1021369", status: "active" },
  { id: "2", pool_type: "constant_product", token_a: fusd, token_b: "uqor", reserve_a: "556540256", reserve_b: "8148853680", status: "active" },
  { id: "3", pool_type: "constant_product", token_a: "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28", token_b: fusd, reserve_a: "137081105701445382", reserve_b: "370106032", status: "active" },
];

describe("buying fUSD on the AMM", () => {
  it("finds the QOR/fUSD pool whichever way round it is listed", () => {
    expect(findPool(pools, "uqor", fusd)?.id).toBe("2");
    expect(findPool(pools, fusd, "uqor")?.id).toBe("2");
    expect(findPool(pools, "uqor", "erc20:0xdead")).toBeUndefined();
  });

  it("quotes the smallest input that pays at least what is wanted (0.30 % fee on the input)", () => {
    const [rIn, rOut] = [8_148_853_680n, 556_540_256n];
    for (const want of [1n, 1_000n, 1_000_000n, 2_500_000n]) {
      const x = amountInFor(rIn, rOut, want);
      expect(amountOut(rIn, rOut, x)).toBeGreaterThanOrEqual(want);
      expect(amountOut(rIn, rOut, x - 1n)).toBeLessThan(want);
    }
    // At these reserves, 1 fUSD costs about 14.7 QOR.
    const one = amountInFor(rIn, rOut, 1_000_000n);
    expect(one > 14_600_000n && one < 14_800_000n).toBe(true);
  });

  it("adds the slippage room and refuses a buy that would move the pool too far", () => {
    const pool = findPool(pools, "uqor", fusd)!;
    const q = quoteBuy(pool, "uqor", fusd, 1_000_000n, 100n);
    expect(q.want).toBe(1_000_000n);
    expect(q.amountIn).toBeGreaterThan(amountInFor(8_148_853_680n, 556_540_256n, 1_000_000n));
    expect(() => quoteBuy(pool, "uqor", fusd, 50_000_000n)).toThrow(/more than 2 %/);
  });

  it("builds swap-then-convert, both encodable for one hybrid transaction", () => {
    const pool = findPool(pools, "uqor", fusd)!;
    const q = quoteBuy(pool, "uqor", fusd, 500_000n);
    const msgs = buyMessages("qor1ppnar99nxc8wq4pyjwt029v0ktcel55952jaj3", getAddress("0x0867D194B3360Ee054249396F5158Fb2F19Fd285"), q);
    expect(msgs.map((m) => m.typeUrl)).toEqual(["/qorechain.amm.v1.MsgSwapExactIn", "/cosmos.evm.erc20.v1.MsgConvertCoin"]);
    const reg = ammRegistry();
    for (const m of msgs) expect(reg.encode(m).length).toBeGreaterThan(20);
    const convert = reg.decode({ typeUrl: msgs[1]!.typeUrl, value: reg.encode(msgs[1]!) }) as { coin: { amount: string; denom: string }; receiver: string };
    expect(convert.coin).toEqual({ denom: fusd, amount: "500000" });
    expect(convert.receiver).toBe("0x0867D194B3360Ee054249396F5158Fb2F19Fd285");
  });
});
