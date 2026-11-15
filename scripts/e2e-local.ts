/**
 * e2e-local.ts - the whole auction on a local anvil chain, with the real
 * cryptography everywhere it can run locally:
 *
 *   - real ML-DSA-87 keys and signatures (SDK `pqcSign`), for committee joins,
 *     recipient cards and releases;
 *   - real QoreSeal ML-KEM-1024 + X25519 envelopes, sealed by the bidder code
 *     and opened by the member code (`client/`, `apps/committee/member.ts`);
 *   - the kit's real `verifyMember`, against a local REST stand-in for
 *     `/qorechain/pqc/v1/kem/{addr}`.
 *
 * The EVM cannot run QoreChain's precompiles, so anvil gets two stand-ins:
 * `MockPqcKeyStatus` at 0x…0A02 (the real public keys are registered in it) and
 * `OraclePqcVerify` at 0x…0A01, whose verdicts this harness records after
 * checking each signature with real ML-DSA-87. The testnet run uses the real
 * precompiles.
 *
 *   npm run e2e:local      (needs anvil on PATH and `forge build`)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveSealKeys, signRecipientCard, toBase64Url, type SealKeyPair } from "@qorechain/qoreseal";
import { classicalKeyFromPrivate } from "@qorechain/qoresign";
import { deriveUnifiedAccount, generateMnemonic, pqcSign, pqcVerify, type UnifiedAccount } from "@qorechain/sdk";
import { cardHash, kemKeySha3, qorAddress } from "qore-pq-kit/threshold";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  encodeAbiParameters,
  parseUnits,
  toBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  bidContext,
  cardToBytes,
  committeeRegistryAbi,
  decodePlaintext,
  encodePlaintext,
  readCommittee,
  resolveCommittee,
  sealBid,
  sealedAuctionAbi,
  sealedAuctionFactoryAbi,
  SEAL_CHAIN_ID,
} from "../client/index.ts";
import { memberStep, STATES, type MemberIdentity } from "../apps/committee/member.ts";

const ROOT = join(import.meta.dirname, "..");
const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as Address;
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as Address;
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex; deployed: Hex } {
  const j = JSON.parse(readFileSync(join(ROOT, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object };
}

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`  ok  ${what}`);
}

async function expectRevert(p: Promise<unknown>, what: string, match?: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (match && !match.test(msg)) throw new Error(`${what}: reverted, but not with ${match}: ${msg.slice(0, 300)}`);
    console.log(`  ok  refused: ${what}`);
    return;
  }
  throw new Error(`CHECK FAILED: ${what} was accepted`);
}

async function startAnvil(): Promise<ChildProcess> {
  const p = spawn("anvil", ["--port", String(PORT), "--silent", "--gas-limit", "60000000", "--code-size-limit", "100000"], {
    stdio: "ignore",
  });
  const c = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 100; i++) {
    try {
      await c.getChainId();
      return p;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

interface Actor {
  name: string;
  acc: UnifiedAccount;
  address: Address;
}

async function main(): Promise<void> {
  const anvil = await startAnvil();
  let rest: Server | undefined;
  try {
    await run((s) => (rest = s));
  } finally {
    anvil.kill();
    rest?.close();
  }
}

async function run(onRest: (s: Server) => void): Promise<void> {
  const client = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) });
  const chainId = BigInt(await client.getChainId());

  // ------------------------------------------------------------ accounts
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
      w = createWalletClient({ account: privateKeyToAccount(a.acc.privateKey as Hex), chain: foundry, transport: http(RPC) });
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
    // Simulate first so a revert surfaces with its reason.
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

  console.log(`anvil at ${RPC}, chain id ${chainId}`);
  const deployer = await actor("deployer");
  const issuer = await actor("issuer");
  const members = [await actor("member1"), await actor("member2"), await actor("member3")];
  const bidders = [await actor("alice"), await actor("bob"), await actor("carol")];

  // ------------------------------------------------------------ precompile stand-ins
  const keyStatus = artifact("MockPqcKeyStatus.sol", "MockPqcKeyStatus");
  const oracle = artifact("OraclePqcVerify.sol", "OraclePqcVerify");
  await test.setCode({ address: PQC_KEY_STATUS, bytecode: keyStatus.deployed });
  await test.setCode({ address: PQC_VERIFY, bytecode: oracle.deployed });
  // The harness plays the precompile: it checks each signature with real ML-DSA-87.
  const attest = async (pubkey: Uint8Array, signature: Hex, message: Hex) => {
    const ok = pqcVerify(pubkey, hexToBytes(message), hexToBytes(signature));
    const d = keccak256(encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [toHex(pubkey), signature, message]));
    await call(deployer, PQC_VERIFY, oracle.abi, "record", [d, ok]);
    return ok;
  };
  for (const m of members) {
    await call(deployer, PQC_KEY_STATUS, keyStatus.abi, "set", [m.address, true, 1, toHex(m.acc.pqc.publicKey), true]);
  }
  console.log("precompile stand-ins installed; members' real ML-DSA-87 keys registered");

  // ------------------------------------------------------------ contracts
  const registry = await deploy(deployer, artifact("CommitteeRegistry.sol", "CommitteeRegistry"));
  const impl = await deploy(deployer, artifact("SealedAuction.sol", "SealedAuction"));
  const factory = await deploy(deployer, artifact("SealedAuctionFactory.sol", "SealedAuctionFactory"), [impl, registry]);
  const mock = artifact("MockERC20.sol", "MockERC20");
  const fusd = await deploy(deployer, mock, ["FestUSD (local)", "fUSD", 6]);
  const pealt = await deploy(deployer, artifact("PealT.sol", "PealT"), [issuer.address, parseUnits("1000000", 18)]);
  console.log(`registry ${registry}\nfactory  ${factory}\nfUSD     ${fusd}\nPEAL-T   ${pealt}`);

  // ------------------------------------------------------------ committee keys, cards, joins
  const seal = new Map<Address, SealKeyPair>();
  const kemRegistry = new Map<string, Uint8Array>(); // what MsgRegisterKEMKey would publish
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
    return { account: m.address, kemKeySha3: kemKeySha3(s.mlkemPublicKey), cardHash: cardHash(card), card: cardToBytes(card), signature: "0x" as Hex };
  });

  // A local REST stand-in for the KEM route; `lie` swaps member 2's key, like a hostile proxy.
  let lie = false;
  const server = createServer((req, res) => {
    const m = /^\/qorechain\/pqc\/v1\/kem\/([^/?]+)/.exec(req.url ?? "");
    const addr = m ? decodeURIComponent(m[1]!) : "";
    let key = kemRegistry.get(addr);
    if (lie && addr === qorAddress(members[1]!.address)) key = deriveSealKeys({ mnemonic: generateMnemonic(256) }).mlkemPublicKey;
    res.setHeader("content-type", "application/json");
    if (!key) return res.end(JSON.stringify({ found: false }));
    res.end(JSON.stringify({ found: true, key: { address: addr, algorithm_id: 2, public_key: toBase64Url(key), registered_height: "1" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  onRest(server);
  const restUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const block = await client.getBlock();
  const joinDeadline = block.timestamp + 3600n;
  const ms = joins.map((j) => ({ account: j.account, kemKeySha3: j.kemKeySha3, cardHash: j.cardHash }));
  const setId = (await client.readContract({ address: registry, abi: committeeRegistryAbi, functionName: "computeSetId", args: [2, ms] })) as Hex;
  for (const [i, m] of members.entries()) {
    const msg = (await client.readContract({
      address: registry,
      abi: committeeRegistryAbi,
      functionName: "joinMessage",
      args: [setId, i + 1, m.address, joins[i]!.kemKeySha3, joins[i]!.cardHash, joinDeadline],
    })) as Hex;
    joins[i]!.signature = toHex(pqcSign(m.acc.pqc.secretKey, hexToBytes(msg)));
    check(await attest(m.acc.pqc.publicKey, joins[i]!.signature, msg), `member ${i + 1} join is a valid ML-DSA-87 signature`);
  }
  await call(deployer, registry, committeeRegistryAbi as Abi, "registerSet", [2, joins, joinDeadline]);
  console.log(`committee 2-of-3 registered: ${setId}`);

  // ------------------------------------------------------------ the bidder's view of the committee
  const committee = await readCommittee(client, registry, setId);
  check(committee.threshold === 2 && committee.members.length === 3, "bidder reads the 2-of-3 committee and its cards from the registry");
  const recipients = await resolveCommittee(committee, { client, rest: restUrl });
  check(recipients.length === 3, "every member passes verifyMember (ML-DSA key on chain, ML-KEM key vs signed hash, card)");
  lie = true;
  await expectRevert(resolveCommittee(committee, { client, rest: restUrl }), "a REST proxy that swaps a member's ML-KEM key", /does not match/);
  lie = false;

  // ------------------------------------------------------------ the auction (a buyback-shaped sale)
  const now = (await client.getBlock()).timestamp;
  const cfg = {
    issuer: issuer.address,
    saleToken: pealt,
    quoteToken: fusd,
    totalSupply: parseUnits("100", 18),
    saleDecimals: 18,
    reservePrice: 1_000_000n,
    tickSize: 500_000n,
    numTicks: 8,
    startTime: now,
    endTime: now + 3600n,
    releaseDeadline: now + 7200n,
    minBidQuantity: 1n,
    maxQuantityPerAddress: 0n,
    maxBids: 64,
    bidBond: 5_000_000n,
    protocolFeeBps: 0,
    feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
    committeeSetId: setId,
    metadataHash: (await client.readContract({
      address: factory,
      abi: sealedAuctionFactoryAbi,
      functionName: "metadataHash",
      args: ["Local demo", "PEAL-T for fUSD"],
    })) as Hex,
  };
  const erc20 = artifact("MockERC20.sol", "MockERC20").abi;
  await call(issuer, pealt, erc20, "approve", [factory, cfg.totalSupply]);
  const created = await client.simulateContract({
    account: issuer.address,
    address: factory,
    abi: sealedAuctionFactoryAbi,
    functionName: "createAuction",
    args: [cfg, "Local demo", "PEAL-T for fUSD"],
  });
  await sendFrom(issuer)({ to: factory, data: encodeFunctionData({ abi: sealedAuctionFactoryAbi, functionName: "createAuction", args: [cfg, "Local demo", "PEAL-T for fUSD"] }) });
  const auction = created.result as Address;
  check(STATES[Number(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "state" }))] === "CommitOpen", `auction ${auction} created, funded and open`);
  check(
    (await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "encodePlaintext", args: [1234n, 5] })) === encodePlaintext(1234n, 5),
    "TS plaintext encoding equals the contract's",
  );

  // ------------------------------------------------------------ sealed bids
  // Worked example: A 50 @ 2.00, B 70 @ 1.50, C 100 @ 1.00 -> clears at 1.50.
  const plan: [Actor, bigint, number][] = [
    [bidders[0]!, parseUnits("50", 18), 2],
    [bidders[1]!, parseUnits("70", 18), 1],
    [bidders[2]!, parseUnits("100", 18), 0],
  ];
  for (const [b, qty, tick] of plan) {
    const ctx = await bidContext(client, auction, b.address, qty, tick);
    await call(deployer, fusd, erc20, "mint", [b.address, ctx.escrow + ctx.bond]);
    await call(b, fusd, erc20, "approve", [auction, ctx.escrow + ctx.bond]);
    const c = sealBid({ chainId, auction, bidder: b.address, seq: ctx.seq, quantity: qty, tick, recipients, threshold: committee.threshold });
    await call(b, auction, sealedAuctionAbi as Abi, "commitBid", [c.seq, c.ct, c.keyHash, c.shareHashes, c.envelopes, ctx.escrow]);
    const bytes = c.envelopes.reduce((n, e) => n + hexToBytes(e).length, 0);
    console.log(`  ${b.name}: sealed bid committed (ct ${c.ct.slice(0, 18)}…, ${bytes} bytes of envelopes, escrow ${ctx.escrow})`);
  }
  // A junk bid: shares that rebuild no key. Excluded, never fatal.
  {
    const b = bidders[2]!;
    const ctx = await bidContext(client, auction, b.address, 1n, 0);
    await call(deployer, fusd, erc20, "mint", [b.address, ctx.escrow + ctx.bond]);
    await call(b, fusd, erc20, "approve", [auction, ctx.escrow + ctx.bond]);
    const c = sealBid({ chainId, auction, bidder: b.address, seq: ctx.seq, quantity: 1n, tick: 0, recipients, threshold: committee.threshold });
    await call(b, auction, sealedAuctionAbi as Abi, "commitBid", [c.seq, c.ct, keccak256(toBytes("not the key")), c.shareHashes, c.envelopes, ctx.escrow]);
    console.log("  carol: junk bid committed (keyHash matches no key)");
  }

  const memberIds: MemberIdentity[] = members.map((m) => ({ address: m.address, pqc: m.acc.pqc, seal: seal.get(m.address)! }));
  const stepFor = (i: number, keeper = false) =>
    memberStep({
      client,
      auction,
      me: memberIds[i]!,
      send: sendFrom(members[i]!),
      keeper,
      beforeSubmit: async (msg, sig) => {
        await attest(members[i]!.acc.pqc.publicKey, sig, msg);
      },
      log: (l) => console.log(`  ${l}`),
    });

  // Before the on-chain close, members do nothing (release on chain state, not a clock).
  check((await stepFor(0)).kind === "waiting", "member 1 waits while bidding is open");

  await test.increaseTime({ seconds: 3600 });
  await test.mine({ blocks: 1 });
  await call(deployer, auction, sealedAuctionAbi as Abi, "closeCommit");
  console.log("bidding closed on chain");

  // A forged release for member 3's slot (signed by an outsider's ML-DSA key) is refused.
  {
    const outsider = await deriveUnifiedAccount(generateMnemonic(256), 0);
    const count = Number(await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCount" }));
    const shares = Array.from({ length: count }, () => 0n);
    const bitmap = (1n << BigInt(count)) - 1n;
    const deadline = (await client.getBlock()).timestamp + 600n;
    const msg = (await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "releaseMessage", args: [3, shares, bitmap, deadline] })) as Hex;
    const sig = toHex(pqcSign(outsider.pqc.secretKey, hexToBytes(msg)));
    check(!(await attest(members[2]!.acc.pqc.publicKey, sig, msg)), "real ML-DSA-87 rejects the outsider's signature against member 3's key");
    await expectRevert(call(deployer, auction, sealedAuctionAbi as Abi, "submitRelease", [3, shares, bitmap, deadline, sig]), "a forged release for member 3", /ReleaseSignatureInvalid/);
  }

  // Members 1 and 2 release; member 3 stays offline.
  check((await stepFor(0)).kind === "released", "member 1 opened its shares in its own process and released");
  check((await stepFor(1)).kind === "released", "member 2 released");
  check((await stepFor(0)).kind === "already-released", "a member releases only once");

  const ids = [0n, 1n, 2n, 3n];
  await call(deployer, auction, sealedAuctionAbi as Abi, "openBids", [ids]);
  for (let i = 0; i < 3; i++) {
    const b = (await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [BigInt(i)] })) as { status: number; quantity: bigint; tick: number };
    check(b.status === 1 && b.quantity === plan[i]![1] && b.tick === plan[i]![2], `bid ${i} opened on chain to ${decodePlaintext(encodePlaintext(b.quantity, b.tick)).quantity} @ tick ${b.tick}, with member 3 offline`);
  }
  await expectRevert(call(deployer, auction, sealedAuctionAbi as Abi, "finalize"), "finalize while member 3 could still release", /ReleaseWindowOpen/);

  await test.increaseTime({ seconds: 3601 });
  await test.mine({ blocks: 1 });
  const k1 = await stepFor(0, true);
  check(k1.kind === "opened", "keeper decides the junk bid once the release window is over");
  const junk = (await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [3n] })) as { status: number; bondBurned: boolean };
  check(junk.status === 3 && !junk.bondBurned, "junk bid excluded as unopenable; bond kept because member 3 never released");
  check((await stepFor(0, true)).kind === "finalized", "keeper finalized");

  const price = (await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "clearingPrice" })) as bigint;
  check(price === 1_500_000n, "uniform clearing price is 1.50 fUSD");
  for (let i = 0; i < 4; i++) await call(deployer, auction, sealedAuctionAbi as Abi, "claim", [BigInt(i)]);
  await call(deployer, auction, sealedAuctionAbi as Abi, "claimProceeds");
  await call(deployer, auction, sealedAuctionAbi as Abi, "claimUnsold");
  const bal = (t: Address, who: Address) => client.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  check((await bal(pealt, bidders[0]!.address)) === parseUnits("50", 18), "alice received 50 PEAL-T");
  check((await bal(pealt, bidders[1]!.address)) === parseUnits("50", 18), "bob received 50 PEAL-T (rationed at the clearing tick)");
  check((await bal(fusd, bidders[0]!.address)) === 25_000_000n + 5_000_000n, "alice paid 1.50, not her 2.00: 25 fUSD + bond refunded");
  check((await bal(fusd, issuer.address)) === 150_000_000n, "issuer received 150 fUSD");
  check((await bal(fusd, auction)) === 0n && (await bal(pealt, auction)) === 0n, "auction holds nothing after every claim");
  console.log("\ngas used (pqcVerify is a stand-in here; on testnet add about 313k per ML-DSA-87 check):");
  for (const [fn, gs] of gasUsed) console.log(`  ${fn.padEnd(16)} ${gs.map(String).join(", ")}`);
  console.log("\nlocal end-to-end run passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
