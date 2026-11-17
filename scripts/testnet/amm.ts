/**
 * amm.ts - buy fUSD (the sale auctions' quote token) on the testnet AMM, as the
 * bid page does for a guest: one hybrid-signed transaction that swaps QOR for
 * the fUSD bank coin with a floor of exactly the amount wanted, then converts
 * that amount into the ERC-20 the auction pulls (`client/amm.ts`).
 *
 *   npm run testnet -- fusd buy <account> <fUSD, e.g. 0.2> [--top-up]
 *
 * --top-up: the deployer first sends the QOR the buy needs (plus 1 QOR for fees)
 * when the account holds less.
 */
import { balances, broadcast, FUSD, network, NATIVE_FEE, publicClient } from "qore-pq-kit";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { ammRegistry, bankDenomOf, buyMessages, fetchPools, findPool, quoteBuy } from "../../client/amm.ts";
import { load } from "./lib.ts";

export async function fusd(args: string[]): Promise<void> {
  const [cmd, name, amount] = args;
  if (cmd !== "buy" || !name || !amount) throw new Error("usage: npm run testnet -- fusd buy <account> <fUSD> [--top-up]");
  const n = await load(name);
  const want = parseUnits(amount, 6);
  const denom = bankDenomOf(FUSD as Address);
  const pool = findPool(await fetchPools(network().rest), "uqor", denom);
  if (!pool) throw new Error("no active QOR/fUSD pool on the testnet AMM");
  const q = quoteBuy(pool, "uqor", denom, want);
  console.log(`pool ${pool.id}: ${amount} fUSD costs at most ${formatUnits(q.amountIn, 6)} QOR (1 % slippage room, 0.30 % fee)`);

  const have = (await balances(n.acc.cosmos)).uqor ?? 0n;
  const need = q.amountIn + 1_000_000n;
  if (have < need) {
    if (!args.includes("--top-up")) throw new Error(`${name} holds ${formatUnits(have, 6)} QOR and needs about ${formatUnits(need, 6)}; pass --top-up`);
    const deployer = await load("deployer");
    const res = await broadcast(deployer.acc, [
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: deployer.acc.cosmos, toAddress: n.acc.cosmos, amount: [{ denom: "uqor", amount: (need - have).toString() }] } },
    ]);
    console.log(`deployer topped ${name} up with ${formatUnits(need - have, 6)} QOR: tx ${res.transactionHash}`);
  }

  const erc20 = () => publicClient().readContract({ address: FUSD as Address, abi: erc20Abi, functionName: "balanceOf", args: [n.evm] });
  const before = await erc20();
  const res = await broadcast(n.acc, buyMessages(n.acc.cosmos, n.evm, q), "hybrid", NATIVE_FEE, ammRegistry());
  const after = await erc20();
  console.log(`${name}: swapped QOR for fUSD and converted ${amount} to the ERC-20 in one transaction: tx ${res.transactionHash}`);
  console.log(`${name} fUSD (ERC-20): ${formatUnits(before, 6)} → ${formatUnits(after, 6)}`);
  if (after - before !== want) throw new Error(`expected +${amount} fUSD on the ERC-20, got ${formatUnits(after - before, 6)}`);
}
