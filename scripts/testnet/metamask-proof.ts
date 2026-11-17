/**
 * metamask-proof.ts - a MetaMask key bids in the visitors' demo auction through
 * a post-quantum account, on the testnet (`client/linked-key.ts`,
 * `@qorechain/wallet-adapter`).
 *
 *   npm run testnet -- metamask-proof [auction]      (default: the open demo auction)
 *
 * The owner is bidder1 (ML-DSA-87 key registered). "MetaMask" is a fresh
 * throwaway secp256k1 key in ~/.qore-peal-sealed-auction/metamask-sim.env (mode
 * 0600, never printed), served through an EIP-1193 provider that answers
 * `personal_sign` exactly as MetaMask does (EIP-191). The script:
 *
 *   1. links the key to bidder1 with a spending rule (one hybrid tx by bidder1):
 *      only the demo faucet's claim, PEAL-T approve, and this auction's
 *      commitBid and claim; PEAL-T only, capped per call and per day;
 *   2. has the key sign a faucet claim, an approve and a sealed commitBid, which
 *      bidder1 relays as MsgExecuteEVM (no EVM window);
 *   3. has the key try a call outside the rule (approve fUSD to itself): the
 *      chain must refuse it;
 *   4. checks that the auction holds a new bid from bidder1's account.
 *
 * Writes deployments/metamask-proof.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAuthNonce } from "@qorechain/sdk";
import { broadcast, loadSecrets, network, publicClient, writeSecrets } from "qore-pq-kit";
import { encodeFunctionData, erc20Abi, formatUnits, hexToBytes, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bidContext, readCommittee, resolveCommittee, sealBid, sealedAuctionAbi } from "../../client/index.ts";
import { bidRule, executionResults, linkMetaMaskMsgs, metaMaskCalls, readLink, type Eip1193 } from "../../client/linked-key.ts";
import { load, secretsFile } from "./lib.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FEE = { amount: [{ denom: "uqor", amount: "450000" }], gas: "3000000" };
const faucetAbi = parseAbi(["function claim(uint256 amount)", "function claimableBy(address who) view returns (uint256 amount, uint64 availableAt)"]);

/** An EIP-1193 provider over a raw key that signs like MetaMask's personal_sign. */
function metaMaskLike(privateKey: Hex): Eip1193 & { address: Address } {
  const a = privateKeyToAccount(privateKey);
  return {
    address: a.address,
    async request({ method, params }) {
      if (method !== "personal_sign") throw new Error(`this stand-in answers personal_sign only, not ${method}`);
      const [data, from] = params as [Hex, string];
      if (from.toLowerCase() !== a.address.toLowerCase()) throw new Error("personal_sign for another address");
      return a.signMessage({ message: { raw: data } });
    },
  };
}

export async function metamaskProof(auctionArg?: string): Promise<void> {
  const d = JSON.parse(readFileSync(join(ROOT, "deployments", "qorechain-diana.json"), "utf8"));
  const web = JSON.parse(readFileSync(join(ROOT, "apps", "web", "public", "config.testnet.json"), "utf8"));
  const auction = (auctionArg ?? web.demoAuction) as Address;
  const net = network();
  const client = publicClient();
  const owner = await load("bidder1");

  if (!existsSync(secretsFile("metamask-sim"))) {
    const pk = generatePrivateKey();
    writeSecrets(secretsFile("metamask-sim"), { PRIVATE_KEY: pk, EVM_ADDRESS: privateKeyToAccount(pk).address }, "A throwaway secp256k1 key standing in for a visitor's MetaMask in metamask-proof.ts. Testnet only. Never commit.");
  }
  const mm = metaMaskLike(loadSecrets(secretsFile("metamask-sim")).PRIVATE_KEY as Hex);
  console.log(`owner bidder1 ${owner.acc.cosmos} (${owner.evm}); MetaMask stand-in ${mm.address}`);

  const cfg = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" });
  const token = cfg.quoteToken as Address;
  const faucet = web.faucet as Address;
  const record: Record<string, unknown> = { auction, owner: owner.acc.cosmos, ownerEvm: owner.evm, metamask: mm.address, token, txs: {} as Record<string, string> };
  const txs = record.txs as Record<string, string>;

  // 1. Link, under the rule (once: a key already linked keeps its rule and expiry).
  const rule = bidRule({ auction, token, faucet, perBid: parseUnits("100", 18), daily: parseUnits("300", 18) });
  record.rule = rule;
  const previous = existsSync(join(ROOT, "deployments", "metamask-proof.json")) ? JSON.parse(readFileSync(join(ROOT, "deployments", "metamask-proof.json"), "utf8")) : undefined;
  const { linked: already } = await fetchAuthNonce({ rest: net.rest, address: owner.acc.cosmos, pubkey: hexToBytes(mm.address) });
  if (already) {
    txs.link = previous?.txs?.link ?? "linked earlier";
    console.log(`1. the MetaMask key is already linked to bidder1 under the rule (tx ${txs.link})`);
  } else {
    const expiryUnix = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
    const link = await linkMetaMaskMsgs({ provider: mm, address: mm.address, owner: owner.acc.cosmos, chainId: net.chainId, rule, expiryUnix });
    const linked = await broadcast(owner.acc, link, "hybrid", FEE);
    txs.link = linked.transactionHash;
    console.log(`1. bidder1 linked the MetaMask key under the rule (expires ${new Date(Number(expiryUnix) * 1000).toISOString()}): tx ${linked.transactionHash}`);
  }
  for (const [k, v] of Object.entries((previous?.txs ?? {}) as Record<string, string>)) if (!(k in txs) && k !== "bid" && k !== "refused") txs[k] = v;
  if (previous?.overLimit) record.overLimit = previous.overLimit;
  const onChain = await readLink(net.rest, owner.acc.cosmos);
  record.ruleOnChain = onChain.rules;

  // 2. MetaMask signs faucet claim, approve and a sealed commitBid; bidder1 relays.
  const fallback = JSON.parse(readFileSync(join(ROOT, "deployments", "committee-cards.json"), "utf8"));
  const committee = await readCommittee(client, d.registry, d.committeeSetId, undefined, fallback);
  const recipients = await resolveCommittee(committee, { client, rest: net.rest });
  // One unit of the sale token (or the auction's minimum), at the lowest price.
  const unit = 10n ** BigInt(cfg.saleDecimals);
  const qty = cfg.minBidQuantity > unit ? cfg.minBidQuantity : unit;
  const tick = 0;
  const ctx = await bidContext(client, auction, owner.evm, qty, tick);
  const needed = ctx.escrow + ctx.bond;
  const bal = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner.evm] });
  const c = sealBid({ chainId: 9800n, auction, bidder: owner.evm, seq: ctx.seq, quantity: qty, tick, recipients, threshold: committee.threshold });
  const calls = [
    ...(bal < needed ? [{ to: faucet, data: encodeFunctionData({ abi: faucetAbi, functionName: "claim", args: [parseUnits("10", 18)] }), gasLimit: 150_000n }] : []),
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [auction, needed] }), gasLimit: 100_000n },
    { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "commitBid", args: [Number(c.seq), c.ct, c.keyHash, c.shareHashes, c.envelopes, ctx.escrow] }), gasLimit: 900_000n },
  ];
  const before = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCount" });
  const signed = await metaMaskCalls({ provider: mm, address: mm.address, owner: owner.acc.cosmos, relayer: owner.acc.cosmos, chainId: net.chainId, rest: net.rest, calls });
  const relayed = await broadcast(owner.acc, signed, "hybrid", FEE);
  const results = executionResults(relayed as never);
  txs.bid = relayed.transactionHash;
  console.log(`2. MetaMask signed ${calls.length} calls (${calls.length === 3 ? "faucet claim, " : ""}approve ${formatUnits(needed, 18)} PEAL-T, sealed commitBid); bidder1 relayed: tx ${relayed.transactionHash}`);
  results.forEach((r, i) => console.log(`   call ${i + 1}: ${r.success ? "executed" : `REFUSED: ${r.error}`}`));
  if (results.length !== calls.length || results.some((r) => !r.success)) throw new Error("a call inside the rule was refused");
  const after = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCount" });
  const bid = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [BigInt(after) - 1n] });
  if (after !== before + 1 || bid.bidder.toLowerCase() !== owner.evm.toLowerCase()) throw new Error(`expected a new bid from ${owner.evm}`);
  record.bidId = Number(after) - 1;
  console.log(`   the auction now holds bid ${after - 1} from bidder1's account, still sealed (ct ${bid.ct.slice(0, 18)}…)`);

  // 3. A call outside the rule: approve fUSD to the MetaMask key itself.
  const bad = await metaMaskCalls({
    provider: mm,
    address: mm.address,
    owner: owner.acc.cosmos,
    relayer: owner.acc.cosmos,
    chainId: net.chainId,
    rest: net.rest,
    calls: [{ to: d.fusd as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [mm.address, parseUnits("100", 6)] }), gasLimit: 100_000n }],
  });
  const refused = await broadcast(owner.acc, bad, "hybrid", FEE);
  const r3 = executionResults(refused as never)[0];
  txs.refused = refused.transactionHash;
  console.log(`3. MetaMask key tried to approve fUSD to itself: ${r3?.success ? "EXECUTED (unexpected)" : `refused by the chain: ${r3?.error}`} (tx ${refused.transactionHash})`);
  if (!r3 || r3.success) throw new Error("the chain did not refuse a call outside the rule");
  record.refusal = r3.error;

  record.date = new Date().toISOString();
  writeFileSync(join(ROOT, "deployments", "metamask-proof.json"), `${JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  console.log("wrote deployments/metamask-proof.json");
}
