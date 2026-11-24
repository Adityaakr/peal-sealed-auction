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
 * The EVM cannot run QoreChain's precompiles; `scripts/local/stack.ts` installs
 * the stand-ins (`MockPqcKeyStatus` with the real public keys, and
 * `OraclePqcVerify`, whose verdicts come from real ML-DSA-87 verification).
 * The testnet run uses the real precompiles.
 *
 *   npm run e2e:local      (needs anvil on PATH)
 */
import { deriveUnifiedAccount, generateMnemonic, pqcSign } from "@qorechain/sdk";
import { hexToBytes, keccak256, parseUnits, toBytes, toHex, type Abi, type Address, type Hex } from "viem";
import { auditAuction } from "../client/audit.ts";
import {
  bidContext,
  checkCommittee,
  escrowChoice,
  escrowNeeded,
  decodePlaintext,
  encodePlaintext,
  readCommittee,
  resolveCommittee,
  sealBid,
  sealedAuctionAbi,
} from "../client/index.ts";
import { memberStep, STATES, type MemberIdentity } from "../apps/committee/member.ts";
import { startStack, type Actor, type Stack } from "./local/stack.ts";

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

async function main(): Promise<void> {
  const s = await startStack();
  try {
    await run(s);
  } finally {
    s.stop();
  }
}

async function run(s: Stack): Promise<void> {
  const { client, test, chainId, deployer, issuer, members, bidders, registry, setId, fusd, pealt, erc20, attest, sendFrom, call, gasUsed } = s;

  // ------------------------------------------------------------ the bidder's view of the committee
  const committee = await readCommittee(client, registry, setId);
  check(committee.threshold === 2 && committee.members.length === 3, "bidder reads the 2-of-3 committee and its cards from the registry");
  const recipients = await resolveCommittee(committee, { client, rest: s.restUrl });
  check(recipients.length === 3, "every member passes verifyMember (ML-DSA key on chain, ML-KEM key vs signed hash, card)");
  s.setLying(true);
  await expectRevert(resolveCommittee(committee, { client, rest: s.restUrl }), "a REST proxy that swaps a member's ML-KEM key", /does not match/);
  s.setLying(false);
  // Bundled cards: used without reading logs when they match the registry, refused when they do not.
  const opts = { rest: s.restUrl };
  check((await checkCommittee(client, registry, setId, { ...opts, bundled: committee })).committee.cardsFrom === "bundled", "bundled cards that match the registry are used, and every member verifies");
  const wrong = structuredClone(committee) as typeof committee;
  wrong.members[0]!.card = { ...wrong.members[0]!.card, x25519PublicKey: wrong.members[1]!.card.x25519PublicKey };
  const again = await checkCommittee(client, registry, setId, { ...opts, bundled: wrong });
  check(again.committee.cardsFrom === "events" && again.committee.refused.join() === "1", "a wrong bundled card is refused; the chain's own card is used instead");

  // ------------------------------------------------------------ the auction (a buyback-shaped sale)
  const auction = await s.createAuction();
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
  const escrowed = new Map<Address, bigint>();
  for (const [b, qty, tick] of plan) {
    const ctx = await bidContext(client, auction, b.address, qty, tick);
    // Bids escrow a rounded-up bucket, as the pages do; the remainder comes back with the claim.
    const terms = await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" });
    if (escrowNeeded(terms, qty, tick) !== ctx.escrow) throw new Error(`escrowNeeded differs from the contract's escrowFor: ${escrowNeeded(terms, qty, tick)} vs ${ctx.escrow}`);
    const escrow = escrowChoice("bucket", ctx.escrow, escrowNeeded(terms, terms.totalSupply, terms.numTicks - 1), 6);
    escrowed.set(b.address, escrow);
    await s.mintFusd(b.address, escrow + ctx.bond);
    await call(b, fusd, erc20, "approve", [auction, escrow + ctx.bond]);
    const c = sealBid({ chainId, auction, bidder: b.address, seq: ctx.seq, quantity: qty, tick, recipients, threshold: committee.threshold });
    await call(b, auction, sealedAuctionAbi as Abi, "commitBid", [c.seq, c.ct, c.keyHash, c.shareHashes, c.envelopes, escrow]);
    const bytes = c.envelopes.reduce((n, e) => n + hexToBytes(e).length, 0);
    console.log(`  ${b.name}: sealed bid committed (ct ${c.ct.slice(0, 18)}…, ${bytes} bytes of envelopes, needs ${ctx.escrow}, escrow ${escrow})`);
  }
  // A junk bid: shares that rebuild no key. Excluded, never fatal.
  {
    const b = bidders[2]!;
    const ctx = await bidContext(client, auction, b.address, 1n, 0);
    await s.mintFusd(b.address, ctx.escrow + ctx.bond);
    await call(b, fusd, erc20, "approve", [auction, ctx.escrow + ctx.bond]);
    const c = sealBid({ chainId, auction, bidder: b.address, seq: ctx.seq, quantity: 1n, tick: 0, recipients, threshold: committee.threshold });
    await call(b, auction, sealedAuctionAbi as Abi, "commitBid", [c.seq, c.ct, keccak256(toBytes("not the key")), c.shareHashes, c.envelopes, ctx.escrow]);
    console.log("  carol: junk bid committed (keyHash matches no key)");
  }

  const memberIds: MemberIdentity[] = members.map((m) => ({ address: m.address, pqc: m.acc.pqc, seal: s.seal.get(m.address)! }));
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
  const bobEscrow = escrowed.get(bidders[1]!.address)!;
  check(bobEscrow > 105_000_000n, `bob escrowed ${bobEscrow / 1_000_000n} fUSD, a bucket above the 105 his bid needs`);
  check((await bal(fusd, bidders[1]!.address)) === bobEscrow - 75_000_000n + 5_000_000n, "bob paid 75 fUSD; the whole remainder of his escrow + bond came back");
  check((await bal(fusd, issuer.address)) === 150_000_000n, "issuer received 150 fUSD");
  check((await bal(fusd, auction)) === 0n && (await bal(pealt, auction)) === 0n, "auction holds nothing after every claim");

  // An outsider's audit, from public data only: release signatures checked off chain with
  // @qorechain/pqc (real ML-DSA-87), every bid reopened from the stored shares.
  const audit = await auditAuction(client, auction);
  check(audit.releases.filter((r) => r.signatureOk === true).length === 2, "audit: both releases verify with ML-DSA-87 off chain, against keys read from pqcKeyStatus");
  check(audit.releases[2]!.note === "no release", "audit: member 3 never released");
  check(audit.bids.slice(0, 3).every((b) => b.agrees === true && b.reopened !== undefined), "audit: every opened bid reopens to what the contract recorded");
  check(audit.bids[3]!.agrees === true && audit.bids[3]!.reopened === undefined, "audit: the junk bid is unopenable from the stored shares too");
  check(audit.ok, "audit passed");
  console.log("\ngas used (pqcVerify is a stand-in here; on testnet add about 313k per ML-DSA-87 check):");
  for (const [fn, gs] of gasUsed) console.log(`  ${fn.padEnd(16)} ${gs.map(String).join(", ")}`);
  console.log("\nlocal end-to-end run passed");
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
