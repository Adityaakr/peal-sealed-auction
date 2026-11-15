/**
 * deploy.ts - deploy Peal Sealed Auction to qorechain-diana and register the
 * committee. Idempotent: addresses are recorded in deployments/qorechain-diana.json
 * and anything already deployed (code at the recorded address) is skipped.
 *
 * Steps:
 *   1. open an UNSCOPED EVM window for the deployer (scoped windows refuse
 *      contract creation), sized for the deploys;
 *   2. deploy CommitteeRegistry, the SealedAuction implementation, the factory,
 *      PEAL-T and its faucet; seed the faucet;
 *   3. each committee member signs a QoreSeal recipient card and an ML-DSA-87
 *      join binding its ML-KEM key hash and card hash; the deployer relays
 *      `registerSet` (2-of-3), checked on chain by pqcVerify;
 *   4. write deployments/qorechain-diana.json and apps/web/public/config.testnet.json;
 *   5. close the window.
 *
 * Gas is estimated by the node (Foundry cannot simulate the PQC precompiles).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { signRecipientCard } from "@qorechain/qoreseal";
import { classicalKeyFromPrivate } from "@qorechain/qoresign";
import { closeEvmWindowMsg, fetchEvmWindow, openEvmWindowMsg, pqcSign, pqcVerify } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { broadcast, FUSD, network, publicClient, sendEvm } from "qore-pq-kit";
import { cardHash, kemKeySha3, qorAddress, readPqKey } from "qore-pq-kit/threshold";
import { encodeDeployData, encodeFunctionData, hexToBytes, parseUnits, toHex, type Abi, type Address, type Hex } from "viem";
import { cardToBytes, committeeRegistryAbi, SEAL_CHAIN_ID } from "../../client/index.ts";
import { artifact } from "../local/stack.ts";
import { COMMITTEE, load, type Named } from "./lib.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DEPLOYMENTS = join(ROOT, "deployments", "qorechain-diana.json");
const WEB_CONFIG = join(ROOT, "apps", "web", "public", "config.testnet.json");

export interface Deployment {
  network: "qorechain-diana";
  evmChainId: 9800;
  deployer: Address;
  registry?: Address;
  implementation?: Address;
  factory?: Address;
  pealt?: Address;
  faucet?: Address;
  fusd: Address;
  committeeSetId?: Hex;
  committee?: { index: number; account: Address; qor: string; kemKeySha3: Hex; cardHash: Hex }[];
  txs: Record<string, Hex>;
}

function readDeployment(deployer: Address): Deployment {
  if (existsSync(DEPLOYMENTS)) return JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployment;
  return { network: "qorechain-diana", evmChainId: 9800, deployer, fusd: FUSD, txs: {} };
}

function save(d: Deployment): void {
  mkdirSync(dirname(DEPLOYMENTS), { recursive: true });
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
}

async function hasCode(a?: Address): Promise<boolean> {
  if (!a) return false;
  const code = await publicClient().getCode({ address: a });
  return !!code && code !== "0x";
}

async function openWindow(n: Named, maxTxs: number, gasPerTx: bigint): Promise<void> {
  const maxValue = evmWindowCost({ gas: gasPerTx, maxFeePerGas: 250_000_000_000n, value: 0n }) * BigInt(maxTxs);
  const res = await broadcast(n.acc, [openEvmWindowMsg({ sender: n.acc.cosmos, blocks: 1800, maxTxs, maxValue })]);
  console.log(`${n.name}: opened an unscoped window (${maxTxs} txs, ${maxValue} uqor), tx ${res.transactionHash}`);
}

async function closeWindow(n: Named): Promise<void> {
  const w = await fetchEvmWindow({ rest: network().rest, address: n.acc.cosmos });
  if (!w.found) return;
  const res = await broadcast(n.acc, [closeEvmWindowMsg(n.acc.cosmos)]);
  console.log(`${n.name}: closed its window, tx ${res.transactionHash}`);
}

async function deployContract(n: Named, file: string, name: string, args: unknown[] = []): Promise<{ address: Address; tx: Hex }> {
  const art = artifact(file, name);
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args } as never);
  const r = await sendEvm(n.acc, { data });
  if (!r.contractAddress) throw new Error(`${name}: no contract address in receipt ${r.transactionHash}`);
  console.log(`deployed ${name} at ${r.contractAddress} (gas ${r.gasUsed}), tx ${r.transactionHash}`);
  return { address: r.contractAddress, tx: r.transactionHash };
}

async function call(n: Named, to: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hex> {
  const r = await sendEvm(n.acc, { to, data: encodeFunctionData({ abi, functionName, args } as never) });
  console.log(`${functionName} on ${to} (gas ${r.gasUsed}), tx ${r.transactionHash}`);
  return r.transactionHash;
}

export async function deploy(): Promise<void> {
  const deployer = await load("deployer");
  const members = await Promise.all(COMMITTEE.map((c) => load(c)));
  const d = readDeployment(deployer.evm);
  const client = publicClient();

  // Every member's ML-DSA key must be on chain and match before anything is spent.
  for (const m of members) {
    const pk = await readPqKey(client, m.evm);
    if (toHex(pk) !== toHex(m.acc.pqc.publicKey)) throw new Error(`${m.name}: the chain holds a different ML-DSA-87 key`);
  }

  await openWindow(deployer, 10, 6_000_000n);
  try {
    if (!(await hasCode(d.registry))) {
      const r = await deployContract(deployer, "CommitteeRegistry.sol", "CommitteeRegistry");
      d.registry = r.address;
      d.txs.registry = r.tx;
      save(d);
    }
    if (!(await hasCode(d.implementation))) {
      const r = await deployContract(deployer, "SealedAuction.sol", "SealedAuction");
      d.implementation = r.address;
      d.txs.implementation = r.tx;
      save(d);
    }
    if (!(await hasCode(d.factory))) {
      const r = await deployContract(deployer, "SealedAuctionFactory.sol", "SealedAuctionFactory", [d.implementation, d.registry]);
      d.factory = r.address;
      d.txs.factory = r.tx;
      save(d);
    }
    if (!(await hasCode(d.pealt))) {
      const r = await deployContract(deployer, "PealT.sol", "PealT", [deployer.evm, parseUnits("1000000", 18)]);
      d.pealt = r.address;
      d.txs.pealt = r.tx;
      save(d);
    }
    if (!(await hasCode(d.faucet))) {
      const r = await deployContract(deployer, "DemoFaucet.sol", "DemoFaucet", [d.pealt, parseUnits("1000", 18), 86_400]);
      d.faucet = r.address;
      d.txs.faucet = r.tx;
      save(d);
      d.txs.faucetSeed = await call(deployer, d.pealt!, artifact("PealT.sol", "PealT").abi, "transfer", [d.faucet, parseUnits("500000", 18)]);
      save(d);
    }

    if (!d.committeeSetId) {
      const now = (await client.getBlock()).timestamp;
      const deadline = now + 3600n;
      const joins = members.map((m) => {
        const qor = qorAddress(m.evm);
        const card = signRecipientCard({
          chainId: SEAL_CHAIN_ID,
          address: qor,
          keys: m.seal,
          classicalKey: classicalKeyFromPrivate(hexToBytes(m.acc.privateKey as Hex), "eth_secp256k1"),
          pqKey: { secretKey: m.acc.pqc.secretKey },
        });
        return { account: m.evm, kemKeySha3: kemKeySha3(m.seal.mlkemPublicKey), cardHash: cardHash(card), card: cardToBytes(card), signature: "0x" as Hex };
      });
      const ms = joins.map((j) => ({ account: j.account, kemKeySha3: j.kemKeySha3, cardHash: j.cardHash }));
      const setId = (await client.readContract({ address: d.registry!, abi: committeeRegistryAbi, functionName: "computeSetId", args: [2, ms] })) as Hex;
      for (const [i, m] of members.entries()) {
        const msg = (await client.readContract({
          address: d.registry!,
          abi: committeeRegistryAbi,
          functionName: "joinMessage",
          args: [setId, i + 1, m.evm, joins[i]!.kemKeySha3, joins[i]!.cardHash, deadline],
        })) as Hex;
        const sig = pqcSign(m.acc.pqc.secretKey, hexToBytes(msg));
        if (!pqcVerify(m.acc.pqc.publicKey, hexToBytes(msg), sig)) throw new Error(`${m.name}: join does not verify locally`);
        joins[i]!.signature = toHex(sig);
      }
      d.txs.registerSet = await call(deployer, d.registry!, committeeRegistryAbi as Abi, "registerSet", [2, joins, deadline]);
      d.committeeSetId = setId;
      d.committee = members.map((m, i) => ({ index: i + 1, account: m.evm, qor: qorAddress(m.evm), kemKeySha3: joins[i]!.kemKeySha3, cardHash: joins[i]!.cardHash }));
      save(d);
      console.log(`committee 2-of-3 registered: ${setId}`);
    }
  } finally {
    await closeWindow(deployer);
  }

  mkdirSync(dirname(WEB_CONFIG), { recursive: true });
  writeFileSync(
    WEB_CONFIG,
    `${JSON.stringify(
      {
        network: "testnet",
        chainId: 9800,
        evmRpc: "https://evm-testnet.qore.host",
        rest: "/rest",
        registry: d.registry,
        factory: d.factory,
        fusd: d.fusd,
        pealt: d.pealt,
        committeeSetId: d.committeeSetId,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${DEPLOYMENTS} and ${WEB_CONFIG}`);
}
