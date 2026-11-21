/**
 * demo.ts - one whole sealed auction on qorechain-diana, with the real
 * precompiles (pqcKeyStatus, pqcVerify) and the real KEM key registry.
 *
 *   npm run testnet -- demo [--commit-seconds 300] [--release-seconds 420]
 *
 * Every EVM transaction runs inside a SCOPED window: each account may call only
 * the contracts it needs (bidders: fUSD and the auction; members: the auction).
 * The run writes every transaction hash to deployments/demo-<auction>.json.
 *
 * Refusal shown without spending gas: a release for member 3's slot signed by an
 * outsider's ML-DSA-87 key is simulated on the node (eth_call runs the real
 * pqcVerify) and must revert with ReleaseSignatureInvalid.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { closeEvmWindowMsg, deriveUnifiedAccount, fetchEvmWindow, generateMnemonic, openEvmWindowMsg, pqcSign } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { broadcast, FUSD, network, publicClient, sendEvm } from "qore-pq-kit";
import { encodeFunctionData, erc20Abi, hexToBytes, parseUnits, toHex, type Abi, type Address, type Hex } from "viem";
import { memberStep } from "../../apps/committee/member.ts";
import { bidContext, readCommittee, resolveCommittee, sealBid, sealedAuctionAbi, sealedAuctionFactoryAbi } from "../../client/index.ts";
import { artifact } from "../local/stack.ts";
import { BIDDERS, COMMITTEE, load, type Named } from "./lib.ts";

const ROOT = join(import.meta.dirname, "..", "..");

export async function scopedWindow(n: Named, targets: Address[], maxTxs: number, gasPerTx: bigint, blocks = 1800): Promise<void> {
  const maxValue = evmWindowCost({ gas: gasPerTx, maxFeePerGas: 250_000_000_000n, value: 0n }) * BigInt(maxTxs);
  const res = await broadcast(n.acc, [
    openEvmWindowMsg({ sender: n.acc.cosmos, blocks, maxTxs, maxValue, allowedTargets: targets.map((t) => t.toLowerCase()) }),
  ]);
  console.log(`${n.name}: window scoped to ${targets.length} contracts, ${maxTxs} txs, tx ${res.transactionHash}`);
}

async function closeWindow(n: Named): Promise<void> {
  const w = await fetchEvmWindow({ rest: network().rest, address: n.acc.cosmos });
  if (w.found) await broadcast(n.acc, [closeEvmWindowMsg(n.acc.cosmos)]);
}

export async function waitUntil(t: bigint, what: string): Promise<void> {
  for (;;) {
    const now = (await publicClient().getBlock()).timestamp;
    if (now > t) return;
    console.log(`waiting ${t - now + 1n}s for ${what}`);
    await new Promise((r) => setTimeout(r, Math.min(30, Number(t - now) + 2) * 1000));
  }
}

/** Bids opened per openBids call: about 120k gas a bid, inside a 3M-gas window transaction. */
const OPEN_CHUNK = 16;

type Evm = (n: Named, label: string, to: Address, abi: Abi, functionName: string, args?: unknown[]) => Promise<unknown>;

/**
 * The deployer (as issuer) opens an auction on the deployed factory: by default
 * 100 PEAL-T for fUSD; with `buyback`, 50 fUSD for PEAL-T, the visitors' demo,
 * which anyone can bid in with PEAL-T from the demo faucet.
 */
async function createAuction(
  d: { pealt: Address; fusd: Address; factory: Address; committeeSetId: Hex },
  deployer: Named,
  commit: bigint,
  release: bigint,
  evm: Evm,
  numTicks = 8,
  opts: { buyback?: boolean; maxBids?: number } = {},
): Promise<{ auction: Address; cfg: { endTime: bigint; releaseDeadline: bigint } }> {
  const client = publicClient();
  const now = (await client.getBlock()).timestamp;
  const buyback = opts.buyback ?? false;
  const name = buyback ? "Peal Sealed Auction: open demo" : "Peal Sealed Auction testnet demo";
  const details = buyback ? "50 fUSD for PEAL-T, open to visitors, 2-of-3 committee" : "100 PEAL-T for fUSD, 2-of-3 committee";
  const cfg = {
    issuer: deployer.evm,
    saleToken: buyback ? d.fusd : d.pealt,
    quoteToken: buyback ? d.pealt : d.fusd,
    totalSupply: buyback ? parseUnits("50", 6) : parseUnits("100", 18),
    saleDecimals: buyback ? 6 : 18,
    // Per whole sale token, in quote base units: 1.00 fUSD + 0.50 steps, or 0.50 PEAL-T + 0.25 steps.
    reservePrice: buyback ? parseUnits("0.5", 18) : 1_000_000n,
    tickSize: buyback ? parseUnits("0.25", 18) : 500_000n,
    numTicks,
    startTime: now,
    endTime: now + commit,
    releaseDeadline: now + commit + release,
    minBidQuantity: 1n,
    maxQuantityPerAddress: 0n,
    // openBids for every bid must fit one 3M-gas window transaction when settling (about 120k a bid).
    maxBids: opts.maxBids ?? 32,
    bidBond: buyback ? parseUnits("1", 18) : 1_000_000n,
    protocolFeeBps: 0,
    feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
    committeeSetId: d.committeeSetId,
    metadataHash: (await client.readContract({ address: d.factory, abi: sealedAuctionFactoryAbi, functionName: "metadataHash", args: [name, details] })) as Hex,
  };
  await scopedWindow(deployer, [cfg.saleToken, d.factory], 2, 1_500_000n);
  await evm(deployer, "approveSupply", cfg.saleToken, artifact("PealT.sol", "PealT").abi, "approve", [d.factory, cfg.totalSupply]);
  const sim = await client.simulateContract({ account: deployer.evm, address: d.factory, abi: sealedAuctionFactoryAbi, functionName: "createAuction", args: [cfg, name, details] });
  await evm(deployer, "createAuction", d.factory, sealedAuctionFactoryAbi as Abi, "createAuction", [cfg, name, details]);
  const auction = sim.result as Address;
  console.log(`auction ${auction}: bidding until ${new Date(Number(cfg.endTime) * 1000).toISOString()}, releases until ${new Date(Number(cfg.releaseDeadline) * 1000).toISOString()}`);
  return { auction, cfg };
}

/** Only open an auction (for the web pages or a recorded demo). */
export async function create(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "commit-seconds": { type: "string", default: "900" },
      // Bidding ends at this UTC time instead (ISO 8601), e.g. 2026-12-17T00:00:00Z.
      until: { type: "string" },
      "release-seconds": { type: "string", default: "900" },
      ticks: { type: "string", default: "8" },
      buyback: { type: "boolean", default: false },
      "max-bids": { type: "string" },
      demo: { type: "boolean", default: false },
    },
  });
  const d = JSON.parse((await import("node:fs")).readFileSync(join(ROOT, "deployments", "qorechain-diana.json"), "utf8"));
  const deployer = await load("deployer");
  const evm: Evm = async (n, label, to, abi, functionName, args = []) => {
    const r = await sendEvm(n.acc, { to, data: encodeFunctionData({ abi, functionName, args } as never) });
    console.log(`${label}: gas ${r.gasUsed}, tx ${r.transactionHash}`);
    return r;
  };
  let commit = BigInt(values["commit-seconds"]!);
  if (values.until) {
    const end = Date.parse(values.until);
    if (Number.isNaN(end)) throw new Error(`--until: not a date: ${values.until}`);
    commit = BigInt(Math.floor(end / 1000)) - (await publicClient().getBlock()).timestamp;
    if (commit <= 0n) throw new Error(`--until: ${values.until} has passed`);
  }
  const { auction } = await createAuction(d, deployer, commit, BigInt(values["release-seconds"]!), evm, Number(values.ticks), {
    buyback: values.buyback,
    maxBids: values["max-bids"] ? Number(values["max-bids"]) : undefined,
  });
  if (values.demo) {
    // Point the pages (and the hosted site) at it as the visitors' open demo auction.
    const path = join(ROOT, "apps", "web", "public", "config.testnet.json");
    const c = JSON.parse(readFileSync(path, "utf8"));
    c.demoAuction = auction;
    writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`);
    console.log(`wrote demoAuction to ${path}`);
  }
}

/**
 * Settle an auction someone else bid on: wait for the end of bidding, close,
 * have members 1 and 2 release (member 3 stays offline), open the bids, wait
 * out the release deadline, decide any bid still pending, finalize. Claims are
 * left to the bidders and the issuer (they are permissionless).
 */
export async function settle(auction: Address): Promise<void> {
  const client = publicClient();
  const deployer = await load("deployer");
  const members = await Promise.all(COMMITTEE.slice(0, 2).map(load));
  const read = <T>(functionName: string) => client.readContract({ address: auction, abi: sealedAuctionAbi, functionName } as never) as Promise<T>;
  const cfg = await read<{ endTime: bigint; releaseDeadline: bigint }>("config");
  const send = async (n: Named, label: string, functionName: string, args: unknown[] = []) => {
    const r = await sendEvm(n.acc, { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName, args } as never) });
    console.log(`${label}: gas ${r.gasUsed}, tx ${r.transactionHash}`);
  };

  await waitUntil(cfg.endTime, "the end of bidding");
  const count = Number(await read<number>("bidCount"));
  console.log(`bidding closed with ${count} bids`);
  // openBids costs about 120k a bid, so open in chunks that fit one 3M-gas window transaction.
  const chunks: bigint[][] = [];
  for (let i = 0; i < count; i += OPEN_CHUNK) chunks.push(Array.from({ length: Math.min(OPEN_CHUNK, count - i) }, (_, k) => BigInt(i + k)));
  // closeCommit, openBids twice per chunk, finalize; the window must outlive the release window.
  await scopedWindow(deployer, [auction], 2 + 2 * Math.max(chunks.length, 1), 3_000_000n, 7200);
  if (Number(await read<number>("state")) === 2) await send(deployer, "closeCommit", "closeCommit");
  if (count === 0) {
    console.log("no bids: the auction failed; the issuer can claimUnsold");
    return;
  }
  for (const m of members) {
    await scopedWindow(m, [auction], 1, 3_000_000n);
    const r = await memberStep({
      client,
      auction,
      me: { address: m.evm, pqc: m.acc.pqc, seal: m.seal },
      rest: network().rest,
      send: async (tx) => (await sendEvm(m.acc, tx)).transactionHash,
      log: (l) => console.log(l),
    });
    console.log(`${m.name}: ${JSON.stringify(r)}`);
  }
  const ids = chunks.flat();
  for (const c of chunks) await send(deployer, `openBids ${c[0]}..${c[c.length - 1]}`, "openBids", [c]);
  await waitUntil(cfg.releaseDeadline, "the release deadline (member 3 is offline)");
  if (Number(await read<number>("decidedCount")) < count) for (const c of chunks) await send(deployer, `openBids (pending) ${c[0]}..${c[c.length - 1]}`, "openBids", [c]);
  await send(deployer, "finalize", "finalize");
  const state = Number(await read<number>("state"));
  const price = await read<bigint>("clearingPrice");
  for (const i of ids) {
    const b = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [i] });
    const alloc = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "allocationOf", args: [i] });
    console.log(`bid ${i}: ${b.bidder} status ${b.status} exclusion ${b.exclusion} qty ${b.quantity} tick ${b.tick} allocation ${alloc}`);
  }
  console.log(`state ${state === 4 ? "Settled" : state === 5 ? "Failed" : state}, clearing price ${price}`);
}

export async function demo(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { "commit-seconds": { type: "string", default: "300" }, "release-seconds": { type: "string", default: "420" } } });
  const d = JSON.parse((await import("node:fs")).readFileSync(join(ROOT, "deployments", "qorechain-diana.json"), "utf8"));
  const client = publicClient();
  const deployer = await load("deployer");
  const members = await Promise.all(COMMITTEE.map(load));
  const bidders = await Promise.all(BIDDERS.map(load));
  const record: Record<string, unknown> = { network: "qorechain-diana", startedAt: new Date().toISOString(), txs: {} as Record<string, Hex> };
  const txs = record.txs as Record<string, Hex>;
  const gas: Record<string, string> = {};
  const evm = async (n: Named, label: string, to: Address, abi: Abi, functionName: string, args: unknown[] = []) => {
    const r = await sendEvm(n.acc, { to, data: encodeFunctionData({ abi, functionName, args } as never) });
    txs[label] = r.transactionHash;
    gas[label] = r.gasUsed.toString();
    console.log(`${label}: gas ${r.gasUsed}, tx ${r.transactionHash}`);
    return r;
  };

  // 1. The issuer (deployer) opens the auction: 100 PEAL-T for fUSD.
  const { auction, cfg } = await createAuction(d, deployer, BigInt(values["commit-seconds"]!), BigInt(values["release-seconds"]!), evm);
  record.auction = auction;
  console.log(`auction ${auction}`);

  // 2. Bidders check the committee against the chain and REST, seal and commit.
  const cardsFile = join(ROOT, "deployments", "committee-cards.json");
  const fallback = existsSync(cardsFile) ? JSON.parse(readFileSync(cardsFile, "utf8")) : undefined;
  const committee = await readCommittee(client, d.registry, d.committeeSetId, undefined, fallback);
  const recipients = await resolveCommittee(committee, { client, rest: network().rest });
  console.log(`committee verified: ${committee.members.map((m) => m.address).join(", ")}`);
  const plan: [Named, bigint, number][] = [
    [bidders[0]!, parseUnits("60", 18), 3],
    [bidders[1]!, parseUnits("70", 18), 1],
  ];
  for (const [b, qty, tick] of plan) {
    const ctx = await bidContext(client, auction, b.evm, qty, tick);
    await scopedWindow(b, [d.fusd, auction], 2, 1_000_000n);
    await evm(b, `${b.name}.approve`, d.fusd, erc20Abi as Abi, "approve", [auction, ctx.escrow + ctx.bond]);
    const c = sealBid({ chainId: 9800n, auction, bidder: b.evm, seq: ctx.seq, quantity: qty, tick, recipients, threshold: committee.threshold });
    await evm(b, `${b.name}.commitBid`, auction, sealedAuctionAbi as Abi, "commitBid", [c.seq, c.ct, c.keyHash, c.shareHashes, c.envelopes, ctx.escrow]);
    // The window admitted exactly these 2 transactions and is now spent; closing it would only cost a fee.
  }

  // 3. Close on chain.
  await waitUntil(cfg.endTime, "the end of bidding");
  await scopedWindow(deployer, [auction], 8, 3_000_000n, 3600);
  await evm(deployer, "closeCommit", auction, sealedAuctionAbi as Abi, "closeCommit");

  // 4. A forged release (outsider's ML-DSA-87 key in member 3's slot): simulated, refused by pqcVerify.
  const outsider = await deriveUnifiedAccount(generateMnemonic(256), 0);
  const count = Number(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCount" }));
  const zeros = Array.from({ length: count }, () => 0n);
  const bitmap = (1n << BigInt(count)) - 1n;
  const dl = (await client.getBlock()).timestamp + 600n;
  const forgedMsg = (await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "releaseMessage", args: [3, zeros, bitmap, dl] })) as Hex;
  try {
    await client.simulateContract({
      account: deployer.evm,
      address: auction,
      abi: sealedAuctionAbi,
      functionName: "submitRelease",
      args: [3, zeros, bitmap, dl, toHex(pqcSign(outsider.pqc.secretKey, hexToBytes(forgedMsg)))],
    });
    throw new Error("the forged release was ACCEPTED in simulation");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (!/ReleaseSignatureInvalid/.test(m)) throw err;
    console.log("forged release for member 3: refused by the real pqcVerify (ReleaseSignatureInvalid)");
    record.forgedRelease = "refused: ReleaseSignatureInvalid (eth_call against the live pqcVerify)";
  }

  // 5. Members 1 and 2 release; member 3 stays offline.
  for (const m of members.slice(0, 2)) {
    await scopedWindow(m, [auction], 1, 3_000_000n);
    const r = await memberStep({
      client,
      auction,
      me: { address: m.evm, pqc: m.acc.pqc, seal: m.seal },
      rest: network().rest,
      send: async (tx) => {
        const rc = await sendEvm(m.acc, tx);
        gas[`${m.name}.submitRelease`] = rc.gasUsed.toString();
        return rc.transactionHash;
      },
      log: (l) => console.log(l),
    });
    if (r.kind !== "released") throw new Error(`${m.name}: ${JSON.stringify(r)}`);
    txs[`${m.name}.submitRelease`] = r.tx; // its 1-transaction window is now spent
  }

  // 6. After the release deadline: open, finalize, pay out (deployer as keeper).
  await evm(deployer, "openBids", auction, sealedAuctionAbi as Abi, "openBids", [Array.from({ length: count }, (_, i) => BigInt(i))]);
  await waitUntil(cfg.releaseDeadline, "the release deadline (member 3 is offline)");
  await evm(deployer, "finalize", auction, sealedAuctionAbi as Abi, "finalize");
  for (let i = 0; i < count; i++) await evm(deployer, `claim${i}`, auction, sealedAuctionAbi as Abi, "claim", [BigInt(i)]);
  await evm(deployer, "claimProceeds", auction, sealedAuctionAbi as Abi, "claimProceeds");
  await evm(deployer, "claimUnsold", auction, sealedAuctionAbi as Abi, "claimUnsold");
  await closeWindow(deployer);

  const price = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "clearingPrice" });
  const bids = [];
  for (let i = 0; i < count; i++) bids.push(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [BigInt(i)] }));
  record.clearingPrice = price.toString();
  record.bids = bids.map((b) => ({ bidder: b.bidder, status: b.status, quantity: b.quantity.toString(), tick: b.tick }));
  record.gasUsed = gas;
  record.finishedAt = new Date().toISOString();
  const out = join(ROOT, "deployments", `demo-${auction}.json`);
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`settled at ${price} (fUSD base units per PEAL-T); wrote ${out}`);
}

/** Close an auction nobody bid on and return its supply to the issuer (deployer). */
export async function closeEmpty(auction: Address): Promise<void> {
  const client = publicClient();
  const deployer = await load("deployer");
  await scopedWindow(deployer, [auction], 2, 300_000n);
  try {
    const state = Number(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "state" }));
    if (state === 2) {
      const r = await sendEvm(deployer.acc, { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "closeCommit" }) });
      console.log(`closeCommit: tx ${r.transactionHash}`);
    }
    const r = await sendEvm(deployer.acc, { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "claimUnsold" }) });
    console.log(`claimUnsold: tx ${r.transactionHash}`);
  } finally {
    await closeWindow(deployer);
  }
}

/**
 * Open the scoped window an account needs before using the web pages on an
 * auction: bidders may call fUSD and the auction (approve + commit), members
 * the auction (one release), the deployer the auction (close, open, finalize, claims).
 */
export async function windowFor(name: string, auction: Address): Promise<void> {
  const n = await load(name);
  if (BIDDERS.includes(name as never)) await scopedWindow(n, [FUSD, auction], 2, 1_000_000n);
  else if (COMMITTEE.includes(name as never)) await scopedWindow(n, [auction], 1, 3_000_000n);
  else await scopedWindow(n, [auction], 10, 3_000_000n, 3600);
}
