/**
 * stack.ts - a local QoreChain stand-in for development and tests.
 *
 * Starts anvil, installs the two precompile stand-ins, deploys the contracts,
 * makes a 2-of-3 committee with REAL ML-DSA-87 keys and QoreSeal keys and
 * cards, registers it with real ML-DSA-87 joins, and serves a local REST
 * stand-in for the routes the apps read:
 *
 *   GET  /qorechain/pqc/v1/kem/{qor1...}   the ML-KEM key a member "registered"
 *   POST /local/attest                     LOCAL ONLY: verify an ML-DSA-87
 *        signature with the real implementation and record the verdict for the
 *        OraclePqcVerify stand-in at 0x…0A01 (see test/mocks/OraclePqcVerify.sol)
 *
 * Used by `scripts/e2e-local.ts` (scripted run) and `scripts/local-stack.ts`
 * (a long-running stack for the web pages).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveSealKeys, signRecipientCard, toBase64Url, type SealKeyPair } from "@qorechain/qoreseal";
import { classicalKeyFromPrivate } from "@qorechain/qoresign";
import { deriveUnifiedAccount, generateMnemonic, pqcSign, pqcVerify, type UnifiedAccount } from "@qorechain/sdk";
import { cardHash, kemKeySha3, qorAddress } from "qore-pq-kit/threshold";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseUnits,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { cardToBytes, committeeRegistryAbi, sealedAuctionAbi, sealedAuctionFactoryAbi, SEAL_CHAIN_ID } from "../../client/index.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as Address;
export const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as Address;

/** The pages' config for a local stack (throwaway mnemonics: never commit the written file). */
export function localWebConfig(s: Stack, auction: Address, demoAuction?: Address) {
  return {
    network: "local",
    chainId: Number(s.chainId),
    evmRpc: s.rpc,
    rest: s.restUrl,
    attestUrl: `${s.restUrl}/local/attest`,
    registry: s.registry,
    factory: s.factory,
    fusd: s.fusd,
    pealt: s.pealt,
    faucet: s.faucet,
    committeeSetId: s.setId,
    auction,
    ...(demoAuction ? { demoAuction } : {}),
    devAccounts: [
      ...s.bidders.map((b) => ({ label: `${b.name} (bidder) ${b.address}`, mnemonic: b.acc.mnemonic! })),
      ...s.members.map((m, i) => ({ label: `member ${i + 1} ${m.address}`, mnemonic: m.acc.mnemonic! })),
      { label: `issuer ${s.issuer.address}`, mnemonic: s.issuer.acc.mnemonic! },
    ],
  };
}

export const LOCAL_WEB_CONFIG = join(ROOT, "apps", "web", "public", "config.local.json");

/** Write the pages' local config (the public/ directory is not in git until a testnet config lands). */
export function writeLocalWebConfig(s: Stack, auction: Address, demoAuction?: Address): string {
  mkdirSync(dirname(LOCAL_WEB_CONFIG), { recursive: true });
  writeFileSync(LOCAL_WEB_CONFIG, JSON.stringify(localWebConfig(s, auction, demoAuction), null, 2));
  return LOCAL_WEB_CONFIG;
}

export function artifact(file: string, name: string): { abi: Abi; bytecode: Hex; deployed: Hex } {
  const j = JSON.parse(readFileSync(join(ROOT, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object };
}

export interface Actor {
  name: string;
  acc: UnifiedAccount;
  address: Address;
}

export interface AuctionOptions {
  name?: string;
  details?: string;
  supply?: bigint;
  commitSeconds?: bigint;
  releaseSeconds?: bigint;
  bidBond?: bigint;
  /** "sale" (default): PEAL-T for fUSD. "buyback": fUSD for PEAL-T, which visitors get from the faucet. */
  kind?: "sale" | "buyback";
}

export interface Stack {
  rpc: string;
  restUrl: string;
  client: PublicClient;
  test: TestClient;
  chainId: bigint;
  deployer: Actor;
  issuer: Actor;
  members: Actor[];
  bidders: Actor[];
  seal: Map<Address, SealKeyPair>;
  registry: Address;
  factory: Address;
  fusd: Address;
  pealt: Address;
  /** PEAL-T demo faucet (1,000 per address per day), as on the testnet. */
  faucet: Address;
  setId: Hex;
  erc20: Abi;
  gasUsed: Map<string, bigint[]>;
  /** Make the REST stand-in swap member 2's ML-KEM key, like a hostile proxy. */
  setLying(on: boolean): void;
  /** Verify with real ML-DSA-87 and record the verdict for 0x…0A01. */
  attest(pubkey: Uint8Array, signature: Hex, message: Hex): Promise<boolean>;
  sendFrom(a: Actor): (tx: { to: Address; data: Hex }) => Promise<Hex>;
  call(a: Actor, to: Address, abi: Abi, functionName: string, args?: unknown[]): Promise<Hex>;
  createAuction(o?: AuctionOptions): Promise<Address>;
  mintFusd(to: Address, amount: bigint): Promise<void>;
  stop(): void;
}

async function startAnvil(port: number): Promise<ChildProcess> {
  const p = spawn("anvil", ["--port", String(port), "--silent", "--gas-limit", "60000000", "--code-size-limit", "100000"], {
    stdio: "ignore",
  });
  const c = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) });
  for (let i = 0; i < 100; i++) {
    try {
      await c.getChainId();
      return p;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  p.kill();
  throw new Error("anvil did not start");
}

export async function startStack(opts: { port?: number; restPort?: number; log?: (l: string) => void } = {}): Promise<Stack> {
  const log = opts.log ?? console.log;
  const port = opts.port ?? 18545 + Math.floor(Math.random() * 1000);
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil(port);
  let server: Server | undefined;
  const stop = () => {
    anvil.kill();
    server?.close();
  };
  try {
    const client = createPublicClient({ chain: foundry, transport: http(rpc) }) as PublicClient;
    const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpc) });
    const chainId = BigInt(await client.getChainId());

    const actor = async (name: string): Promise<Actor> => {
      const acc = await deriveUnifiedAccount(generateMnemonic(256), 0);
      const address = getAddress(acc.evm);
      await test.setBalance({ address, value: 10n ** 21n });
      return { name, acc, address };
    };
    const wallets = new Map<Address, ReturnType<typeof createWalletClient>>();
    const walletOf = (a: Actor) => {
      let w = wallets.get(a.address);
      if (!w) {
        w = createWalletClient({ account: privateKeyToAccount(a.acc.privateKey as Hex), chain: foundry, transport: http(rpc) });
        wallets.set(a.address, w);
      }
      return w;
    };
    const gasUsed = new Map<string, bigint[]>();
    const named = [...(sealedAuctionAbi as Abi), ...(committeeRegistryAbi as Abi), ...(sealedAuctionFactoryAbi as Abi)];
    const sendFrom = (a: Actor) => async (tx: { to: Address; data: Hex }): Promise<Hex> => {
      const w = walletOf(a);
      const hash = await w.sendTransaction({ account: w.account!, chain: foundry, to: tx.to, data: tx.data, gas: 30_000_000n });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
      try {
        const { functionName } = decodeFunctionData({ abi: named, data: tx.data });
        if (tx.to !== PQC_VERIFY && tx.to !== PQC_KEY_STATUS) gasUsed.set(functionName, [...(gasUsed.get(functionName) ?? []), r.gasUsed]);
      } catch {
        // not one of ours (token approvals, mocks)
      }
      return hash;
    };
    const call = async (a: Actor, to: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<Hex> => {
      await client.simulateContract({ account: a.address, address: to, abi, functionName, args } as never);
      return sendFrom(a)({ to, data: encodeFunctionData({ abi, functionName, args } as never) });
    };
    const deploy = async (a: Actor, art: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> => {
      const w = walletOf(a);
      const hash = await w.deployContract({ account: w.account!, chain: foundry, abi: art.abi, bytecode: art.bytecode, args } as never);
      const r = await client.waitForTransactionReceipt({ hash });
      if (!r.contractAddress) throw new Error("deploy failed");
      return r.contractAddress;
    };

    log(`anvil at ${rpc}, chain id ${chainId}`);
    const deployer = await actor("deployer");
    const issuer = await actor("issuer");
    const members = [await actor("member1"), await actor("member2"), await actor("member3")];
    const bidders = [await actor("alice"), await actor("bob"), await actor("carol")];

    // Precompile stand-ins.
    const keyStatus = artifact("MockPqcKeyStatus.sol", "MockPqcKeyStatus");
    const oracle = artifact("OraclePqcVerify.sol", "OraclePqcVerify");
    await test.setCode({ address: PQC_KEY_STATUS, bytecode: keyStatus.deployed });
    await test.setCode({ address: PQC_VERIFY, bytecode: oracle.deployed });
    const attest = async (pubkey: Uint8Array, signature: Hex, message: Hex) => {
      const ok = pqcVerify(pubkey, hexToBytes(message), hexToBytes(signature));
      const d = keccak256(
        encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [toHex(pubkey), signature, message]),
      );
      await call(deployer, PQC_VERIFY, oracle.abi, "record", [d, ok]);
      return ok;
    };
    for (const m of members) {
      await call(deployer, PQC_KEY_STATUS, keyStatus.abi, "set", [m.address, true, 1, toHex(m.acc.pqc.publicKey), true]);
    }
    log("precompile stand-ins installed; members' real ML-DSA-87 keys registered");

    // Contracts.
    const registry = await deploy(deployer, artifact("CommitteeRegistry.sol", "CommitteeRegistry"));
    const impl = await deploy(deployer, artifact("SealedAuction.sol", "SealedAuction"));
    const factory = await deploy(deployer, artifact("SealedAuctionFactory.sol", "SealedAuctionFactory"), [impl, registry]);
    const mock = artifact("MockERC20.sol", "MockERC20");
    const fusd = await deploy(deployer, mock, ["FestUSD (local)", "fUSD", 6]);
    const pealt = await deploy(deployer, artifact("PealT.sol", "PealT"), [issuer.address, parseUnits("1000000", 18)]);
    const faucet = await deploy(deployer, artifact("DemoFaucet.sol", "DemoFaucet"), [pealt, parseUnits("1000", 18), 86_400n]);
    log(`registry ${registry}\nfactory  ${factory}\nfUSD     ${fusd}\nPEAL-T   ${pealt}\nfaucet   ${faucet}`);

    // Committee keys, cards and joins.
    const seal = new Map<Address, SealKeyPair>();
    const kemRegistry = new Map<string, Uint8Array>();
    const joins = members.map((m) => {
      const s = deriveSealKeys({ mnemonic: m.acc.mnemonic! });
      seal.set(m.address, s);
      const qor = qorAddress(m.address);
      kemRegistry.set(qor, s.mlkemPublicKey);
      const card = signRecipientCard({
        chainId: SEAL_CHAIN_ID,
        address: qor,
        keys: s,
        classicalKey: classicalKeyFromPrivate(hexToBytes(m.acc.privateKey as Hex), "eth_secp256k1"),
        pqKey: { secretKey: m.acc.pqc.secretKey },
        issuedAt: "2026-11-16T00:00:00Z",
      });
      return {
        account: m.address,
        kemKeySha3: kemKeySha3(s.mlkemPublicKey),
        cardHash: cardHash(card),
        card: cardToBytes(card),
        signature: "0x" as Hex,
      };
    });

    // REST stand-in.
    let lying = false;
    const pubkeyOf = new Map(members.map((m) => [m.address.toLowerCase(), m.acc.pqc.publicKey]));
    server = createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("content-type", "application/json");
      if (req.method === "OPTIONS") return res.end();
      if (req.method === "POST" && req.url === "/local/attest") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          void (async () => {
            try {
              const { signer, signature, message } = JSON.parse(body) as { signer: string; signature: Hex; message: Hex };
              const pk = pubkeyOf.get(signer.toLowerCase());
              if (!pk) throw new Error("unknown signer");
              res.end(JSON.stringify({ ok: await attest(pk, signature, message) }));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }
      const m = /^\/qorechain\/pqc\/v1\/kem\/([^/?]+)/.exec(req.url ?? "");
      const addr = m ? decodeURIComponent(m[1]!) : "";
      let key = kemRegistry.get(addr);
      if (lying && addr === qorAddress(members[1]!.address)) key = deriveSealKeys({ mnemonic: generateMnemonic(256) }).mlkemPublicKey;
      if (!key) return res.end(JSON.stringify({ found: false }));
      res.end(JSON.stringify({ found: true, key: { address: addr, algorithm_id: 2, public_key: toBase64Url(key), registered_height: "1" } }));
    });
    await new Promise<void>((r) => server!.listen(opts.restPort ?? 0, "127.0.0.1", () => r()));
    const restUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const joinDeadline = (await client.getBlock()).timestamp + 3600n;
    const ms = joins.map((j) => ({ account: j.account, kemKeySha3: j.kemKeySha3, cardHash: j.cardHash }));
    const setId = (await client.readContract({
      address: registry,
      abi: committeeRegistryAbi,
      functionName: "computeSetId",
      args: [2, ms],
    })) as Hex;
    for (const [i, m] of members.entries()) {
      const msg = (await client.readContract({
        address: registry,
        abi: committeeRegistryAbi,
        functionName: "joinMessage",
        args: [setId, i + 1, m.address, joins[i]!.kemKeySha3, joins[i]!.cardHash, joinDeadline],
      })) as Hex;
      joins[i]!.signature = toHex(pqcSign(m.acc.pqc.secretKey, hexToBytes(msg)));
      if (!(await attest(m.acc.pqc.publicKey, joins[i]!.signature, msg))) throw new Error(`member ${i + 1} join did not verify`);
    }
    await call(deployer, registry, committeeRegistryAbi as Abi, "registerSet", [2, joins, joinDeadline]);
    log(`committee 2-of-3 registered: ${setId}`);

    const erc20 = mock.abi;
    await call(issuer, pealt, erc20, "transfer", [faucet, parseUnits("100000", 18)]);
    const createAuction = async (o: AuctionOptions = {}): Promise<Address> => {
      const now = (await client.getBlock()).timestamp;
      const name = o.name ?? "Local demo";
      const buyback = o.kind === "buyback";
      const details = o.details ?? (buyback ? "fUSD for PEAL-T" : "PEAL-T for fUSD");
      const cfg = {
        issuer: issuer.address,
        saleToken: buyback ? fusd : pealt,
        quoteToken: buyback ? pealt : fusd,
        totalSupply: o.supply ?? (buyback ? parseUnits("50", 6) : parseUnits("100", 18)),
        saleDecimals: buyback ? 6 : 18,
        // Price per whole sale token, in quote base units: 1.00 + 0.50 steps (fUSD), or 0.50 + 0.25 steps (PEAL-T).
        reservePrice: buyback ? parseUnits("0.5", 18) : 1_000_000n,
        tickSize: buyback ? parseUnits("0.25", 18) : 500_000n,
        numTicks: 8,
        startTime: now,
        endTime: now + (o.commitSeconds ?? 3600n),
        releaseDeadline: now + (o.commitSeconds ?? 3600n) + (o.releaseSeconds ?? 3600n),
        minBidQuantity: 1n,
        maxQuantityPerAddress: 0n,
        maxBids: 64,
        bidBond: o.bidBond ?? (buyback ? parseUnits("1", 18) : 5_000_000n),
        protocolFeeBps: 0,
        feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
        committeeSetId: setId,
        metadataHash: (await client.readContract({
          address: factory,
          abi: sealedAuctionFactoryAbi,
          functionName: "metadataHash",
          args: [name, details],
        })) as Hex,
      };
      if (buyback) await call(deployer, fusd, erc20, "mint", [issuer.address, cfg.totalSupply]);
      await call(issuer, cfg.saleToken, erc20, "approve", [factory, cfg.totalSupply]);
      const sim = await client.simulateContract({
        account: issuer.address,
        address: factory,
        abi: sealedAuctionFactoryAbi,
        functionName: "createAuction",
        args: [cfg, name, details],
      });
      await sendFrom(issuer)({
        to: factory,
        data: encodeFunctionData({ abi: sealedAuctionFactoryAbi, functionName: "createAuction", args: [cfg, name, details] }),
      });
      return sim.result as Address;
    };
    const mintFusd = async (to: Address, amount: bigint) => {
      await call(deployer, fusd, erc20, "mint", [to, amount]);
    };

    return {
      rpc,
      restUrl,
      client,
      test,
      chainId,
      deployer,
      issuer,
      members,
      bidders,
      seal,
      registry,
      factory,
      fusd,
      pealt,
      faucet,
      setId,
      erc20,
      gasUsed,
      setLying: (on) => {
        lying = on;
      },
      attest,
      sendFrom,
      call,
      createAuction,
      mintFusd,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}
