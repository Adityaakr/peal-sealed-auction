/**
 * bond.ts - a sealed issue of PEAL-B, a demo bond only post-quantum accounts may
 * hold, on the testnet (`src/demo/PealBond.sol`, QoreChain's Asset Kit guard).
 *
 *   npm run testnet -- bond                 (about 25 minutes: 10 of bidding, 10 of releases)
 *
 *   1. The deployer deploys the Asset Kit's `QoreChainHybridHolderGuard` (unchanged,
 *      from lib/qorechain-asset-kit at v0.1.0) and PEAL-B (1,000 to the issuer).
 *   2. Reads: the guard sees the live pqcKeyStatus precompile, the project's accounts
 *      are hybrid holders, a fresh address is not.
 *   3. The deployer opens a sealed sale of 100 PEAL-B for fUSD on the venue's factory.
 *   4. bidder1 and bidder2 seal and commit (scoped windows).
 *   5. Settle: members 1 and 2 release, the bids open, the auction finalizes.
 *   6. Payouts: each allocation is a PEAL-B transfer the guard checks against the
 *      live precompile; the unsold rest returns to the issuer.
 *   7. A transfer of PEAL-B to an address without an ML-DSA-87 key is refused (eth_call).
 *
 * Resumes from deployments/bond-demo.json. Spends test QOR of the project's accounts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEvmWindowMsg, fetchEvmWindow, openEvmWindowMsg } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { broadcast, network, publicClient, sendEvm } from "qore-pq-kit";
import { BaseError, ContractFunctionRevertedError, encodeDeployData, encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bidContext, readCommittee, resolveCommittee, sealBid, sealedAuctionAbi, sealedAuctionFactoryAbi } from "../../client/index.ts";
import { artifact } from "../local/stack.ts";
import { scopedWindow, settle, waitUntil } from "./demo.ts";
import { load, type Named } from "./lib.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FILE = join(ROOT, "deployments", "bond-demo.json");
const NAME = "Peal Bond 2027 (demo): sealed issue";
const DETAILS = "100 PEAL-B for fUSD; PEAL-B may be held only by accounts with a registered ML-DSA-87 key (QoreChain Asset Kit guard)";

export async function bondDemo(): Promise<void> {
  const d = JSON.parse(readFileSync(join(ROOT, "deployments", "qorechain-diana.json"), "utf8"));
  const rec: Record<string, unknown> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { network: "qorechain-diana", txs: {} };
  const txs = rec.txs as Record<string, string>;
  const save = () => writeFileSync(FILE, `${JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  const client = publicClient();
  const deployer = await load("deployer");
  const bidders = [await load("bidder1"), await load("bidder2")];
  const guardArt = artifact("QoreChainHybridHolderGuard.sol", "QoreChainHybridHolderGuard");
  const bondArt = artifact("PealBond.sol", "PealBond");
  const evm = async (n: Named, label: string, to: Address, abi: Abi, functionName: string, args: unknown[] = []) => {
    const r = await sendEvm(n.acc, { to, data: encodeFunctionData({ abi, functionName, args } as never) });
    txs[label] = r.transactionHash;
    save();
    console.log(`${label}: gas ${r.gasUsed}, tx ${r.transactionHash}`);
    return r;
  };

  // 1. Deploy (a scoped window refuses contract creation, so one unscoped window for exactly two).
  if (!rec.guard) {
    const maxValue = evmWindowCost({ gas: 2_500_000n, maxFeePerGas: 250_000_000_000n, value: 0n }) * 2n;
    const w = await broadcast(deployer.acc, [openEvmWindowMsg({ sender: deployer.acc.cosmos, blocks: 600, maxTxs: 2, maxValue })]);
    txs.deployWindow = w.transactionHash;
    const g = await sendEvm(deployer.acc, { data: encodeDeployData({ abi: guardArt.abi, bytecode: guardArt.bytecode, args: [deployer.evm] } as never) });
    rec.guard = g.contractAddress;
    txs.guard = g.transactionHash;
    save();
    console.log(`deployed the Asset Kit's QoreChainHybridHolderGuard at ${g.contractAddress}, tx ${g.transactionHash}`);
  }
  if (!rec.bond) {
    const b = await sendEvm(deployer.acc, {
      data: encodeDeployData({ abi: bondArt.abi, bytecode: bondArt.bytecode, args: [rec.guard, d.factory, deployer.evm, parseUnits("1000", 18)] } as never),
    });
    rec.bond = b.contractAddress;
    txs.bond = b.transactionHash;
    save();
    console.log(`deployed PEAL-B at ${b.contractAddress} (1,000 to the issuer), tx ${b.transactionHash}`);
    const w = await fetchEvmWindow({ rest: network().rest, address: deployer.acc.cosmos });
    if (w.found && w.live) await broadcast(deployer.acc, [closeEvmWindowMsg(deployer.acc.cosmos)]);
  }
  const guard = rec.guard as Address;
  const bond = rec.bond as Address;

  // 2. What the guard sees on the live chain.
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  const gread = (fn: string, args: unknown[] = []) => client.readContract({ address: guard, abi: guardArt.abi, functionName: fn, args } as never) as Promise<boolean>;
  const reads = {
    precompileActive: await gread("precompileActive"),
    deployerIsHybridHolder: await gread("isHybridHolder", [deployer.evm]),
    bidder1IsHybridHolder: await gread("isHybridHolder", [bidders[0]!.evm]),
    bidder2IsHybridHolder: await gread("isHybridHolder", [bidders[1]!.evm]),
    freshAddressIsHybridHolder: await gread("isHybridHolder", [fresh]),
  };
  rec.guardReads = reads;
  save();
  console.log(`guard on the live chain: ${JSON.stringify(reads)}`);
  if (!reads.precompileActive || !reads.bidder1IsHybridHolder || reads.freshAddressIsHybridHolder) throw new Error("the guard does not see the chain as expected");

  // 3. The sealed issue.
  if (!rec.auction) {
    const now = (await client.getBlock()).timestamp;
    const cfg = {
      issuer: deployer.evm,
      saleToken: bond,
      quoteToken: d.fusd as Address,
      totalSupply: parseUnits("100", 18),
      saleDecimals: 18,
      reservePrice: 1_000_000n,
      tickSize: 500_000n,
      numTicks: 8,
      startTime: now,
      endTime: now + 600n,
      releaseDeadline: now + 1200n,
      minBidQuantity: 1n,
      maxQuantityPerAddress: 0n,
      maxBids: 8,
      bidBond: 1_000_000n,
      protocolFeeBps: 0,
      feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
      committeeSetId: d.committeeSetId,
      metadataHash: (await client.readContract({ address: d.factory, abi: sealedAuctionFactoryAbi, functionName: "metadataHash", args: [NAME, DETAILS] })) as Hex,
    };
    await scopedWindow(deployer, [bond, d.factory], 2, 1_500_000n);
    await evm(deployer, "approveSupply", bond, bondArt.abi, "approve", [d.factory, cfg.totalSupply]);
    const sim = await client.simulateContract({ account: deployer.evm, address: d.factory, abi: sealedAuctionFactoryAbi, functionName: "createAuction", args: [cfg, NAME, DETAILS] });
    await evm(deployer, "createAuction", d.factory, sealedAuctionFactoryAbi as Abi, "createAuction", [cfg, NAME, DETAILS]);
    rec.auction = sim.result as Address;
    save();
    console.log(`sealed issue ${rec.auction}: 100 PEAL-B for fUSD, bidding until ${new Date(Number(cfg.endTime) * 1000).toISOString()}`);
  }
  const auction = rec.auction as Address;

  // 4. Bids.
  if (!txs["bidder1.commitBid"]) {
    const fallback = JSON.parse(readFileSync(join(ROOT, "deployments", "committee-cards.json"), "utf8"));
    const committee = await readCommittee(client, d.registry, d.committeeSetId, undefined, fallback);
    const recipients = await resolveCommittee(committee, { client, rest: network().rest });
    const plan: [Named, bigint, number][] = [
      [bidders[0]!, parseUnits("30", 18), 3],
      [bidders[1]!, parseUnits("80", 18), 1],
    ];
    for (const [b, qty, tick] of plan) {
      const ctx = await bidContext(client, auction, b.evm, qty, tick);
      await scopedWindow(b, [d.fusd, auction], 2, 1_000_000n);
      await evm(b, `${b.name}.approve`, d.fusd, erc20Abi as Abi, "approve", [auction, ctx.escrow + ctx.bond]);
      const c = sealBid({ chainId: 9800n, auction, bidder: b.evm, seq: ctx.seq, quantity: qty, tick, recipients, threshold: committee.threshold });
      await evm(b, `${b.name}.commitBid`, auction, sealedAuctionAbi as Abi, "commitBid", [c.seq, c.ct, c.keyHash, c.shareHashes, c.envelopes, ctx.escrow]);
    }
  }

  // 5. Settle (waits for the close and the release deadline). A run interrupted after the
  //    releases and openBids only has finalize left, which joins the payout window below.
  const read = (functionName: string) => client.readContract({ address: auction, abi: sealedAuctionAbi, functionName } as never) as Promise<unknown>;
  const state = Number(await read("state"));
  const onlyFinalizeLeft = state === 3 && Number(await read("decidedCount")) === Number(await read("bidCount")) && (await read("releaseWindowOver")) === true;
  if (state < 4 && !onlyFinalizeLeft) await settle(auction);

  // 6. Payouts: every PEAL-B transfer here passes the Asset Kit guard on the live precompile.
  if (!txs.claimUnsold) {
    const cfg = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" });
    await waitUntil(cfg.releaseDeadline, "payouts");
    const finalize = Number(await read("state")) === 3;
    await scopedWindow(deployer, [auction], finalize ? 5 : 4, 1_000_000n);
    if (finalize) await evm(deployer, "finalize", auction, sealedAuctionAbi as Abi, "finalize");
    for (const i of [0n, 1n]) await evm(deployer, `claim${i}`, auction, sealedAuctionAbi as Abi, "claim", [i]);
    await evm(deployer, "claimProceeds", auction, sealedAuctionAbi as Abi, "claimProceeds");
    await evm(deployer, "claimUnsold", auction, sealedAuctionAbi as Abi, "claimUnsold");
  }
  const bal = (who: Address) => client.readContract({ address: bond, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  rec.pealB = {
    bidder1: formatUnits(await bal(bidders[0]!.evm), 18),
    bidder2: formatUnits(await bal(bidders[1]!.evm), 18),
    issuer: formatUnits(await bal(deployer.evm), 18),
    auction: formatUnits(await bal(auction), 18),
  };
  rec.clearingPrice = formatUnits(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "clearingPrice" }), 6);
  console.log(`PEAL-B after payouts: ${JSON.stringify(rec.pealB)}; clearing price ${rec.clearingPrice} fUSD`);

  // 7. The refusal: bidder1 tries to send PEAL-B to an address without a key.
  try {
    await client.simulateContract({ account: bidders[0]!.evm, address: bond, abi: bondArt.abi, functionName: "transfer", args: [fresh, 1n] } as never);
    throw new Error("a transfer to an address without an ML-DSA-87 key was NOT refused");
  } catch (e) {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
    if (name !== "NotEligible") throw e;
    rec.refusal = `transfer of PEAL-B from bidder1 to ${fresh} (no ML-DSA-87 key): reverts NotEligible`;
    console.log(rec.refusal);
  }
  rec.date = new Date().toISOString();
  save();
  console.log("wrote deployments/bond-demo.json");
}
