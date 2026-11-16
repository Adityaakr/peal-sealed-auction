/**
 * setup.ts - get the project's testnet accounts ready. Safe to re-run: every
 * step reads chain state first and skips what is already done (the chain
 * charges a fee even for a refused duplicate registration).
 *
 * 1. deployer registers its ML-DSA-87 key (the one message signed classically);
 * 2. deployer tops up the others with QOR (and the bidders with fUSD bank
 *    coins) when they fall below a floor;
 * 3. every account registers its ML-DSA-87 key with a proof of possession;
 * 4. every committee member registers its ML-KEM-1024 key (MsgRegisterKEMKey,
 *    hybrid-signed; QoreX cannot send it, so this script does);
 * 5. each bidder converts its fUSD bank coins to the ERC-20 the auction uses.
 */
import { fetchKemKey } from "@qorechain/qoreseal/network";
import {
  buildRegisterPqcKeyMsg,
  fetchPqcStatus,
  KEM_ALGORITHM_ML_KEM_1024,
  msg as sdkMsg,
  isRegisteredPqcKey,
  signProofOfPossession,
  verifyProofOfPossession,
} from "@qorechain/sdk";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { balances, broadcast, convertCoinMsg, festRegistry, FUSD, FUSD_DENOM, network, publicClient, qor } from "qore-pq-kit";
import { erc20Abi } from "viem";
import { ACCOUNTS, BIDDERS, COMMITTEE, load, type Named } from "./lib.ts";

// Thin: one faucet claim funds every entry of the fest. Accounts are topped up
// to TARGET when they fall below FLOOR, so repeated demo runs keep working.
const TARGET = { committee: 2_000_000n, bidder: 1_500_000n }; // uqor
const FLOOR = { committee: 800_000n, bidder: 600_000n }; // uqor
const FUSD_TARGET = 200_000_000n; // 200 fUSD (6 decimals), ERC-20 plus bank
const FUSD_FLOOR = 120_000_000n;

export async function registerPqcFor(n: Named): Promise<void> {
  const net = network();
  const st = await fetchPqcStatus({ rest: net.rest, address: n.acc.cosmos });
  if (st.registered) {
    if (isRegisteredPqcKey(st, n.acc.pqc.publicKey) === false) throw new Error(`${n.name} has a DIFFERENT ML-DSA key registered`);
    console.log(`${n.name}: ML-DSA-87 key already registered`);
    return;
  }
  const proof = signProofOfPossession({ chainId: net.chainId, account: n.acc.cosmos, keypair: n.acc.pqc });
  if (!verifyProofOfPossession({ chainId: net.chainId, account: n.acc.cosmos, publicKey: n.acc.pqc.publicKey, proof })) {
    throw new Error("proof of possession does not verify locally");
  }
  const res = await broadcast(n.acc, [buildRegisterPqcKeyMsg(n.acc.cosmos, { pqcKeypair: n.acc.pqc, proofOfPossession: proof })], "classical");
  console.log(`${n.name}: registered ML-DSA-87 key, tx ${res.transactionHash}`);
}

async function registerKem(n: Named): Promise<void> {
  const kem = await fetchKemKey({ rest: network().rest, address: n.acc.cosmos });
  const same = kem.registered && kem.publicKey && Buffer.from(kem.publicKey).equals(Buffer.from(n.seal.mlkemPublicKey));
  if (same) {
    console.log(`${n.name}: ML-KEM-1024 key already registered`);
    return;
  }
  const msg = sdkMsg.pqc.registerKemKey({ sender: n.acc.cosmos, algorithmId: KEM_ALGORITHM_ML_KEM_1024, publicKey: n.seal.mlkemPublicKey as never });
  const res = await broadcast(n.acc, [msg], "hybrid");
  console.log(`${n.name}: registered ML-KEM-1024 key, tx ${res.transactionHash}`);
}

/** Cosmos refuses a MsgSend whose coins are not sorted by denom ("invalid coins"). */
function send(from: Named, to: Named, coins: { denom: string; amount: bigint }[]): EncodeObject {
  return {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: from.acc.cosmos, toAddress: to.acc.cosmos, amount: [...coins].sort((a, b) => (a.denom < b.denom ? -1 : 1)).map((c) => ({ denom: c.denom, amount: c.amount.toString() })) },
  };
}

export async function setup(): Promise<void> {
  const all = new Map<string, Named>();
  for (const name of ACCOUNTS) all.set(name, await load(name));
  const deployer = all.get("deployer")!;

  const bal = await balances(deployer.acc.cosmos);
  console.log(`deployer ${deployer.acc.cosmos}: ${qor(bal.uqor ?? 0n)}, fUSD bank ${bal[FUSD_DENOM] ?? 0n}`);
  if ((bal.uqor ?? 0n) === 0n) throw new Error(`fund the deployer ${deployer.evm} (${deployer.acc.cosmos}) from the faucet first`);
  await registerPqcFor(deployer);

  // Top up whoever is below its floor, in one hybrid transaction.
  const msgs: EncodeObject[] = [];
  for (const name of [...COMMITTEE, ...BIDDERS]) {
    const n = all.get(name)!;
    const b = await balances(n.acc.cosmos);
    const role = COMMITTEE.includes(name) ? "committee" : "bidder";
    const coins: { denom: string; amount: bigint }[] = [];
    const q = b.uqor ?? 0n;
    if (q < FLOOR[role]) coins.push({ denom: "uqor", amount: TARGET[role] - q });
    if (role === "bidder") {
      const erc = await publicClient().readContract({ address: FUSD, abi: erc20Abi, functionName: "balanceOf", args: [n.evm] });
      const have = erc + (b[FUSD_DENOM] ?? 0n);
      if (have < FUSD_FLOOR && (bal[FUSD_DENOM] ?? 0n) >= FUSD_TARGET - have) coins.push({ denom: FUSD_DENOM, amount: FUSD_TARGET - have });
    }
    if (coins.length) msgs.push(send(deployer, n, coins));
  }
  if (msgs.length) {
    const res = await broadcast(deployer.acc, msgs);
    console.log(`deployer funded ${msgs.length} accounts, tx ${res.transactionHash}`);
  }

  for (const name of [...COMMITTEE, ...BIDDERS]) await registerPqcFor(all.get(name)!);
  for (const name of COMMITTEE) await registerKem(all.get(name)!);
  for (const name of BIDDERS) {
    const n = all.get(name)!;
    const b = await balances(n.acc.cosmos);
    const bank = b[FUSD_DENOM] ?? 0n;
    if (bank === 0n) continue;
    const res = await broadcast(n.acc, [convertCoinMsg(n.acc.cosmos, FUSD_DENOM, bank, n.evm)], "hybrid", undefined, festRegistry());
    console.log(`${name}: converted ${bank} fUSD to ERC-20, tx ${res.transactionHash}`);
  }
  console.log("setup done");
}
