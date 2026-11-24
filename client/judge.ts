/**
 * judge.ts - the attempts behind the /judge page and `npm run judge:live`.
 *
 * Every attempt is an `eth_call` to the deployed testnet contracts, made with
 * `attempts.ts`. The release attacks run at the block where the first open demo was
 * really waiting for releases, and start from a genuine release read from its
 * transaction, so each one differs from a call the chain accepted in exactly one
 * way. What a call cannot reach is said in `limits`, not skipped.
 *
 * No key, no account, no transaction. Nothing here can change the chain.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  getContractAddress,
  hexToBytes,
  pad,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { committeeRegistryAbi, demoFaucetAbi, sealedAuctionAbi, sealedAuctionFactoryAbi } from "./abi.ts";
import { batchInitcode, ethCall, NetworkError, rpc, RpcError, verdict, type Call, type Endpoint, type Expect, type Outcome, type Verdict } from "./attempts.ts";
import { memberKey, releaseAuthMessage, verifyReleaseSignature } from "./audit.ts";
import type { Committee } from "./committee.ts";
import { escrowChoice, escrowNeeded } from "./escrow.ts";
import { FORGED } from "./judge-forged.ts";

export interface ReleaseRef {
  member: number;
  tx: Hex;
  /** The block its transaction landed in. */
  block: bigint;
}

/** Where the attempts run. Every block and hash is also in deployments/. */
export const JUDGE = {
  rpc: "https://evm-testnet.qore.host",
  rest: "https://api-testnet.qore.host",
  chainId: 9800,
  /** The 16 November run: 100 PEAL-T sold, member 3 offline. */
  firstRun: {
    auction: "0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124" as Address,
    closeBlock: 10_183_610n,
    firstRelease: 10_183_622n,
    finalizeTx: "0x85a2df47dbf5a5cf5d4473db222170432c568990bdda03b1f4847e4e9045e44d" as Hex,
    releaseTxs: ["0xc999a0c26b698e64836486c637f3e126e11317d1ca06cf4e6b00c63d8293ee68", "0xcc039c7dd19f1d0626dea38d42834140d228c686d22ce1ff693950d9e0113007"] as Hex[],
  },
  /** The first open demo: three bids from visitors' guest accounts, settled on 23 November. */
  openDemo: {
    auction: "0x9A98Fc3b3B5078Bd22bAE5fb937395Ba1AE8c7B4" as Address,
    closeBlock: 10_630_860n,
    releases: [
      { member: 1, tx: "0x41be498122263c7d9aa65e29aafc25be03590e9f16d0a4a28f2682b0ce12a856", block: 10_630_882n },
      { member: 2, tx: "0x9be175179c15e583665ac97ed8224de99f67a9ceee737838f66bf1b37ec8129c", block: 10_630_904n },
      { member: 3, tx: "0xec0d4b521bfa0ace019a90a17b837ba6ef94efc633ef9f3e3bc351e963917855", block: 10_630_945n },
    ] as ReleaseRef[],
    finalizeTx: "0x7a0c8f182895a3820ff4f86f1b3bbf610b69d65468686f6c1e8393ef2de888e5" as Hex,
  },
  /** A genuine release by the same member 1 in a later auction with the same number of bids as `firstRun`. */
  otherAuction: {
    auction: "0xd919f252cd684af3822df42f160baedf61dcdf68" as Address,
    release: { member: 1, tx: "0x8745144b53bf564a868ed4f41d0295782399317946238e4412f629be8d57ae84", block: 10_218_890n } as ReleaseRef,
  },
  registerSet: { tx: "0x470ce18a4e0ba1782ca737381f18535ca6169b5b8908b53680e0454c17b0b593" as Hex, block: 10_183_212n },
} as const;

/** `SealedAuction.State`. */
export const STATE = { CommitOpen: 2, Closed: 3, Settled: 4 } as const;

const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as Address;
/** The sender of the batched calls: an address nobody holds, so its nonce is 0 and the batch's address is fixed. */
const NOBODY = "0x00000000000000000000000000000000000000Aa" as Address;
const BATCH = getContractAddress({ from: NOBODY, nonce: 0n });

const ERC20_ERRORS = [
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
] as const;

/** Every error any attempt can meet, so a refusal for the wrong reason is named too. */
export const ERRORS: Abi = [...new Map(
  [...sealedAuctionAbi, ...committeeRegistryAbi, ...sealedAuctionFactoryAbi, ...demoFaucetAbi, ...ERC20_ERRORS]
    .filter((x) => x.type === "error")
    .map((x) => [`${x.name}(${x.inputs.map((i) => i.type).join()})`, x] as const),
).values()];

// ------------------------------------------------------------------ evidence, read from the chain

export interface Release {
  auction: Address;
  from: Address;
  index: number;
  shares: readonly bigint[];
  invalidBitmap: bigint;
  deadline: bigint;
  signature: Hex;
  /** The calldata exactly as its transaction carried it. */
  data: Hex;
}

async function txOf(ep: Endpoint, tx: Hex, to: Address): Promise<{ from: Address; input: Hex }> {
  const t = await rpc<{ from: Address; to: Address; input: Hex } | null>(ep, "eth_getTransactionByHash", [tx]);
  if (!t) throw new Error(`the node no longer has transaction ${tx}`);
  if (t.to.toLowerCase() !== to.toLowerCase()) throw new Error(`transaction ${tx} is not a call to ${to}`);
  return { from: getAddress(t.from), input: t.input };
}

/** A member's genuine release, from its transaction's calldata. */
export async function loadRelease(ep: Endpoint, auction: Address, ref: ReleaseRef): Promise<Release> {
  const t = await txOf(ep, ref.tx, auction);
  const d = decodeFunctionData({ abi: sealedAuctionAbi, data: t.input });
  if (d.functionName !== "submitRelease") throw new Error(`transaction ${ref.tx} is not a release`);
  const [index, shares, invalidBitmap, deadline, signature] = d.args;
  if (Number(index) !== ref.member) throw new Error(`transaction ${ref.tx} is member ${index}'s release`);
  return { auction: getAddress(auction), from: t.from, index: Number(index), shares, invalidBitmap, deadline, signature, data: t.input };
}

const submitRelease = (a: { index: number; shares: readonly bigint[]; invalidBitmap: bigint; deadline: bigint; signature: Hex }): Hex =>
  encodeFunctionData({ abi: sealedAuctionAbi, functionName: "submitRelease", args: [a.index, a.shares as bigint[], a.invalidBitmap, a.deadline, a.signature] });

// ------------------------------------------------------------------ what a page needs to give

export interface JudgeContext {
  ep: Endpoint;
  client: PublicClient;
  rest: string;
  fetch?: typeof globalThis.fetch;
  registry: Address;
  factory: Address;
  pealt: Address;
  faucet: Address;
  committeeSetId: Hex;
  openAuction: Address;
  /** The committee's cards as shipped with the site (checked against the chain before use). */
  cards: () => Promise<Committee>;
}

/**
 * `attack`: must be refused. `control`: the genuine call, which must work (or get past
 * the check). `limit`: something the contract does accept, shown so nobody has to find it.
 */
export type Role = "attack" | "control" | "limit";

interface StepBase {
  id: string;
  role: Role;
  label: string;
  /** What was changed, or why this answer is the right one. */
  why: string;
}

export interface CallStep extends StepBase {
  kind: "call";
  call: Call;
  expect: Expect;
  /** A reason this step cannot run now (bidding is over, the state differs), read from the chain. */
  given?: () => Promise<string | undefined>;
  /** The answer in words, when it was accepted. */
  said?: (data: Hex) => string;
}

/** A check made in the visitor's browser, where no contract call can reach. */
export interface LocalStep extends StepBase {
  kind: "local";
  run: () => Promise<{ ok: boolean; said: string }>;
}

export type Step = CallStep | LocalStep;

export interface Attempt {
  id: string;
  title: string;
  /** The question a judge would ask. */
  question: string;
  steps: () => Promise<Step[]>;
  /** What no call can show, in plain words. */
  limits: string[];
}

export interface StepResult {
  step: Step;
  outcome?: Outcome;
  verdict: Verdict;
  said: string;
  ms: number;
}

/** Run one step. Never throws: a failure to ask is "not-run". */
export async function runStep(ctx: JudgeContext, step: Step): Promise<StepResult> {
  const t0 = Date.now();
  const done = (r: Omit<StepResult, "step" | "ms">): StepResult => ({ step, ms: Date.now() - t0, ...r });
  try {
    if (step.kind === "local") {
      const r = await step.run();
      return done({ verdict: r.ok ? { kind: "intended" } : { kind: "wrongly-accepted" }, said: r.said });
    }
    const blocked = await step.given?.();
    if (blocked) return done({ verdict: { kind: "not-run", why: blocked }, said: blocked });
    const outcome = await ethCall(ctx.ep, step.call, ERRORS);
    const v = verdict(outcome, step.expect);
    const said =
      outcome.kind === "accepted"
        ? (step.said?.(outcome.data) ?? "accepted")
        : outcome.kind === "refused"
          ? describe(outcome)
          : whyNot(outcome);
    return done({ outcome, verdict: v, said });
  } catch (err) {
    const why = reason(err);
    return done({ verdict: { kind: "not-run", why }, said: why });
  }
}

export function reason(err: unknown): string {
  if (err instanceof NetworkError) return `The testnet RPC could not be reached (${err.message}).`;
  if (err instanceof RpcError) return `The testnet RPC answered: ${err.message}`;
  // viem wraps network trouble, sometimes inside a contract error.
  for (let e: unknown = err, i = 0; e instanceof Error && i < 6; e = e.cause, i++) {
    if (/^(HttpRequestError|TimeoutError)$/.test(e.name)) return "The testnet RPC did not answer.";
  }
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}

function whyNot(o: Extract<Outcome, { kind: "unavailable" }>): string {
  if (o.why === "history") return "This node no longer keeps the state of that block, so the attempt could not run. The last attempt needs no history.";
  if (o.why === "network") return `The testnet RPC could not be reached (${o.message}).`;
  return `The testnet RPC answered: ${o.message}`;
}

const STATE_NAMES = ["Created", "Funded", "CommitOpen", "Closed", "Settled", "Failed", "Cancelled"];

function describe(o: Extract<Outcome, { kind: "refused" }>): string {
  if (!o.name) return o.data === "0x" ? "reverted without data" : `reverted with ${o.data.slice(0, 10)}`;
  const args = o.args.map((a) => (o.name === "BadState" ? (STATE_NAMES[Number(a)] ?? String(a)) : typeof a === "string" && !a.startsWith("0x") ? `"${a}"` : typeof a === "string" && a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-4)}` : String(a)));
  return `${o.name}(${args.join(", ")})`;
}

// ------------------------------------------------------------------ the attempts

/** The contract is at `block` and in `state`, so an answer there means something. */
function inState(ctx: JudgeContext, auction: Address, block: bigint, state: number, what: string): () => Promise<string | undefined> {
  return async () => {
    const o = await ethCall(ctx.ep, { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "state" }), block }, ERRORS);
    if (o.kind === "unavailable") return whyNot(o);
    if (o.kind === "accepted" && o.data.length === 66 && Number(BigInt(o.data)) === state) return undefined;
    return `At block ${block} the auction does not read as ${what}, so nothing was sent.`;
  };
}

/** The open auction still takes bids. */
function biddingOpen(ctx: JudgeContext): () => Promise<string | undefined> {
  return async () => {
    const [state, cfg, block] = await Promise.all([
      ctx.client.readContract({ address: ctx.openAuction, abi: sealedAuctionAbi, functionName: "state" }),
      ctx.client.readContract({ address: ctx.openAuction, abi: sealedAuctionAbi, functionName: "config" }),
      ctx.client.getBlock(),
    ]);
    if (Number(state) === STATE.CommitOpen && block.timestamp < cfg.endTime) return undefined;
    return "Bidding in the open auction is over, so this attempt no longer applies.";
  };
}

const bidTuple = (data: Hex) => decodeFunctionResult({ abi: sealedAuctionAbi, functionName: "getBid", data });

export function attempts(ctx: JudgeContext): Attempt[] {
  const { openDemo, firstRun } = JUDGE;
  const A = openDemo.auction;
  const [r1, r2] = [openDemo.releases[0]!, openDemo.releases[1]!];
  const beforeRelease = r1.block - 1n;
  const beforeClose = openDemo.closeBlock - 1n;
  const waiting = inState(ctx, A, beforeRelease, STATE.Closed, "closed and waiting for releases");

  // Each piece of evidence is fetched once; a failed fetch is tried again on the next run.
  const once = <T>(f: () => Promise<T>): (() => Promise<T>) => {
    let p: Promise<T> | undefined;
    return () => (p ??= f().catch((e: unknown) => { p = undefined; throw e; }));
  };
  const release1 = once(() => loadRelease(ctx.ep, A, r1));
  const release2 = once(() => loadRelease(ctx.ep, A, r2));
  const foreign = once(() => loadRelease(ctx.ep, JUDGE.otherAuction.auction, JUDGE.otherAuction.release));
  const joins = once(async () => {
    const t = await txOf(ctx.ep, JUDGE.registerSet.tx, ctx.registry);
    const d = decodeFunctionData({ abi: committeeRegistryAbi, data: t.input });
    if (d.functionName !== "registerSet") throw new Error("not a registerSet transaction");
    return { data: t.input, args: d.args };
  });
  const bidCount = async () => Number(await ctx.client.readContract({ address: ctx.openAuction, abi: sealedAuctionAbi, functionName: "bidCount" }));

  const call = (s: Omit<CallStep, "kind">): CallStep => ({ kind: "call", ...s });
  const attack = (s: Omit<CallStep, "kind" | "role">): CallStep => call({ role: "attack", ...s });
  const control = (s: Omit<CallStep, "kind" | "role">): CallStep => call({ role: "control", ...s });

  /** Claim, approve and commit in one call, as a fresh address. `n` is the committee size the bid was sealed for. */
  const commitBatch = (a: { ct: Hex; keyHash: Hex; shareHashes: readonly Hex[]; envelopes: readonly Hex[]; escrow: bigint }): Call => ({
    from: NOBODY,
    data: batchInitcode([
      { to: ctx.faucet, data: encodeFunctionData({ abi: demoFaucetAbi, functionName: "claim", args: [10n ** 21n] }) },
      { to: ctx.pealt, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ctx.openAuction, 10n ** 21n] }) },
      { to: ctx.openAuction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "commitBid", args: [0, a.ct, a.keyHash, a.shareHashes as Hex[], a.envelopes as Hex[], a.escrow] }) },
    ]),
  });
  const junk = (n: number) => ({
    ct: pad("0x01", { size: 32 }),
    keyHash: pad("0x02", { size: 32 }),
    shareHashes: Array.from({ length: n }, (_, i) => pad(toHex(i + 1), { size: 32 })),
    envelopes: Array.from({ length: n }, () => `0x${"5a".repeat(1752)}` as Hex),
    escrow: 10n ** 19n,
  });
  const committed = (data: Hex) => `accepted: it would be bid ${BigInt(data)}`;
  // A visitor may commit between the read and the call, so a later id is right too.
  const isNextBid = (n: number) => (data: Hex) => (data.length === 66 && Number(BigInt(data)) >= n ? undefined : `an unexpected answer ${data.slice(0, 20)}`);

  return [
    {
      id: "control",
      title: "The genuine release is accepted",
      question: "Does the call path work at all?",
      steps: async () => {
        const g = await release1();
        return [
          control({ id: "genuine", label: "Member 1's real release, one block before it landed", why: "The exact bytes of its transaction. The release attacks below start from this call.", given: waiting, call: { to: A, data: g.data, block: beforeRelease }, expect: { accepted: true }, said: () => "accepted" }),
          control({
            id: "genuine-effect",
            label: "The same release, then the contract's own count",
            why: "Two calls in one eth_call: submitRelease, then releaseCount, which must have gone from 0 to 1.",
            given: waiting,
            call: { from: NOBODY, data: batchInitcode([{ to: A, data: g.data }, { to: A, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "releaseCount" }) }]), block: beforeRelease },
            expect: { accepted: true, check: (d) => (d.length === 66 && BigInt(d) === 1n ? undefined : "releaseCount is not 1") },
            said: () => "accepted: releaseCount is 1",
          }),
        ];
      },
      limits: ["Nothing is written: eth_call runs the contract and throws the result away. The release itself is on chain, in the transaction linked under “The first open demo”."],
    },
    {
      id: "forged",
      title: "Forged release",
      question: "Can someone with a stolen classical key release for a member?",
      steps: async () => {
        const g = await release1();
        const key = await memberKey(ctx.client, g.from);
        const message = releaseAuthMessage({ chainId: BigInt(JUDGE.chainId), auction: A, member: g.from, bidCount: g.shares.length, shares: g.shares, invalidBitmap: g.invalidBitmap, deadline: g.deadline });
        return [
          {
            kind: "local",
            id: "forged-valid",
            role: "control",
            label: "First, in this browser: the forgery is a real signature",
            why: "An outsider's valid ML-DSA-87 signature over the exact message, so only the identity of the signer is wrong.",
            run: async () => {
              const outsider = verifyReleaseSignature(hexToBytes(FORGED.publicKey), message, hexToBytes(FORGED.signature));
              const member = key ? verifyReleaseSignature(key, message, hexToBytes(FORGED.signature)) : undefined;
              return { ok: outsider && member === false, said: outsider && member === false ? "valid under the outsider's key, invalid under member 1's" : "the forgery is not what it should be" };
            },
          },
          attack({ id: "forged-member", label: "Sent from member 1's own address", why: "Only the signature differs from the genuine call. The sender is member 1's address, as a thief of its classical key would send it.", given: waiting, call: { from: g.from, to: A, data: submitRelease({ ...g, signature: FORGED.signature }), block: beforeRelease }, expect: { refused: "ReleaseSignatureInvalid" } }),
          attack({ id: "forged-byte", label: "The genuine signature with one byte changed", why: "One byte of the 4,627 is different.", given: waiting, call: { to: A, data: submitRelease({ ...g, signature: flipByte(g.signature, 2000) }), block: beforeRelease }, expect: { refused: "ReleaseSignatureInvalid" } }),
        ];
      },
      limits: ["The refusal is pqcVerify's, reached through the contract. A member's own ML-DSA-87 key, if stolen, would pass this check: that is what the 2-of-3 split is for."],
    },
    {
      id: "early",
      title: "Early release",
      question: "Can bids be opened on chain while bidding is open?",
      steps: async () => {
        const g = await release1();
        return [
          attack({ id: "early-genuine", label: "The genuine release, one block before bidding closed", why: "The same bytes the control accepted. Only the moment differs.", given: inState(ctx, A, beforeClose, STATE.CommitOpen, "open for bids"), call: { to: A, data: g.data, block: beforeClose }, expect: { refused: "BadState", args: [STATE.CommitOpen] } }),
          attack({ id: "early-open", label: "A release into today's open auction", why: "The state check comes first, so whatever the release holds, it stops here.", given: biddingOpen(ctx), call: { to: ctx.openAuction, data: g.data }, expect: { refused: "BadState", args: [STATE.CommitOpen] } }),
          attack({ id: "early-close", label: "Closing today's open auction early", why: "Nobody, the issuer included, can end bidding before endTime.", given: biddingOpen(ctx), call: { to: ctx.openAuction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "closeCommit" }) }, expect: { refused: "TooEarly" } }),
        ];
      },
      limits: [
        "Today's open auction cannot show the signature check: no release can get past its state, and its members have signed none. The first row uses a real, fully valid release instead.",
        "The chain cannot stop two members from combining their shares off chain before the close. Secrecy assumes fewer than two collude, and in this demo one owner holds all three keys.",
      ],
    },
    {
      id: "replayed",
      title: "Replayed release",
      question: "Can a real release be used again, or somewhere else?",
      steps: async () => {
        const [g, f] = await Promise.all([release1(), foreign()]);
        const landed = inState(ctx, A, r1.block, STATE.Closed, "closed and waiting for releases");
        return [
          attack({ id: "replay-same", label: "The same release again, right after it landed", why: "Same bytes, one block later.", given: landed, call: { to: A, data: g.data, block: r1.block }, expect: { refused: "AlreadyReleased", args: [1] } }),
          attack({ id: "replay-slot", label: "Member 1's release in member 3's free slot", why: "Slot 3 has not released, so only the signer's identity can refuse it.", given: landed, call: { to: A, data: submitRelease({ ...g, index: 3 }), block: r1.block }, expect: { refused: "ReleaseSignatureInvalid" } }),
          attack({ id: "replay-auction", label: "Member 1's release for another auction, in the 16 November run", why: "Same committee, same member, same number of bids and an unexpired deadline, so only the auction the signature names is wrong.", given: inState(ctx, firstRun.auction, firstRun.firstRelease - 1n, STATE.Closed, "closed and waiting for releases"), call: { to: firstRun.auction, data: f.data, block: firstRun.firstRelease - 1n }, expect: { refused: "ReleaseSignatureInvalid" } }),
          attack({ id: "replay-today", label: "The same release today", why: "The auction is settled, so the state check refuses it before the replay check is asked.", call: { to: A, data: g.data }, expect: { refused: "BadState", args: [STATE.Settled] } }),
        ];
      },
      limits: ["At the latest block both settled auctions refuse any release as settled; the replay check itself is reachable only at the older blocks used here."],
    },
    {
      id: "edited",
      title: "Edited arguments",
      question: "Can a relayer change what a member signed?",
      steps: async () => {
        const g = await release1();
        const at = (id: string, label: string, why: string, change: Partial<Release>) =>
          attack({ id, label, why, given: waiting, call: { to: A, data: submitRelease({ ...g, ...change }), block: beforeRelease }, expect: { refused: "ReleaseSignatureInvalid" } });
        return [
          at("edit-share", "One share changed by 1", "Would open bid 0 to something else.", { shares: [g.shares[0]! + 1n, ...g.shares.slice(1)] }),
          at("edit-drop", "Bid 1 marked as unopenable", "Would try to knock a bidder out.", { shares: g.shares.map((s, i) => (i === 1 ? 0n : s)), invalidBitmap: 2n }),
          at("edit-deadline", "The deadline one second later", "Would keep a signature alive for longer.", { deadline: g.deadline + 1n }),
        ];
      },
      limits: ["Behind the signature, the contract also checks every share against the hash the bidder committed (WrongShare). No call here can reach that check, because it takes a member's own signature over a wrong share; the Foundry test test_releaseWithWrongShareRevertsWhole covers it."],
    },
    {
      id: "one-key",
      title: "One member alone",
      question: "Is one released key enough to open a bid?",
      steps: async () => {
        const [a, b] = await Promise.all([release1(), release2()]);
        const n = a.shares.length;
        const flow = (releases: Release[]): Call => ({
          from: NOBODY,
          block: beforeRelease,
          data: batchInitcode([
            ...releases.map((r) => ({ to: A, data: r.data })),
            { to: A, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "openBids", args: [Array.from({ length: n }, (_, i) => BigInt(i))] }) },
            { to: A, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "getBid", args: [0n] }) },
          ]),
        });
        return [
          attack({ id: "one-of-three", label: "One genuine release, then openBids", why: "Not a revert: openBids leaves a bid alone until two shares rebuild its key.", given: waiting, call: flow([a]), expect: { accepted: true, check: (d) => { const x = bidTuple(d); return x.status === 0 && x.quantity === 0n ? undefined : "the bid opened with one share"; } }, said: (d) => (bidTuple(d).status === 0 ? "bid 0 is still sealed" : "bid 0 OPENED") }),
          control({ id: "two-of-three", label: "Two genuine releases, then openBids", why: "The contract rebuilds the key and decrypts the bid itself.", given: waiting, call: flow([a, b]), expect: { accepted: true, check: (d) => { const x = bidTuple(d); return x.status === 1 && x.quantity === 10_000_000n && x.tick === 3 ? undefined : "bid 0 did not open to 10 fUSD at limit step 3"; } }, said: (d) => { const x = bidTuple(d); return x.status === 1 ? `bid 0 opened: ${Number(x.quantity) / 1e6} fUSD at limit step ${x.tick}` : "bid 0 did not open"; } }),
        ];
      },
      limits: ["This shows what the contract does with one release. That one share reveals nothing about the key is a property of the 2-of-3 split, tested in test-ts/client.test.ts."],
    },
    {
      id: "committee",
      title: "A bid to the wrong committee",
      question: "Can a bid go to people who are not this auction's committee?",
      steps: async () => {
        const [n, j, cfg] = await Promise.all([bidCount(), joins(), ctx.client.readContract({ address: ctx.openAuction, abi: sealedAuctionAbi, functionName: "config" })]);
        const [threshold, members, deadline] = j.args as [number, readonly { account: Address; kemKeySha3: Hex; cardHash: Hex; card: Hex; signature: Hex }[], bigint];
        const swapped = members.map((m, i) => (i === 1 ? { ...m, kemKeySha3: `0x${"11".repeat(32)}` as Hex } : m));
        const before = JUDGE.registerSet.block - 1n;
        const registrySlot = async () => {
          const o = await ethCall(ctx.ep, { to: ctx.registry, data: encodeFunctionData({ abi: committeeRegistryAbi, functionName: "exists", args: [ctx.committeeSetId] }), block: before }, ERRORS);
          if (o.kind === "unavailable") return whyNot(o);
          return o.kind === "accepted" && o.data.length === 66 && BigInt(o.data) === 0n ? undefined : `At block ${before} the registry does not read as deployed and empty, so nothing was sent.`;
        };
        const metadataHash = await ctx.client.readContract({ address: ctx.factory, abi: sealedAuctionFactoryAbi, functionName: "metadataHash", args: ["judge", "judge"] });
        const create = (committeeSetId: Hex): Call => ({ from: cfg.issuer, to: ctx.factory, data: encodeFunctionData({ abi: sealedAuctionFactoryAbi, functionName: "createAuction", args: [{ ...cfg, committeeSetId, metadataHash }, "judge", "judge"] }) });
        const open = biddingOpen(ctx);
        const { real, refuseSwappedCards } = await sealing(ctx, cfg, threshold);
        const steps: Step[] = [
          control({ id: "bid-right", label: "A bid sealed in this browser for the real committee", why: "Each member's keys were checked first. Then one eth_call claims PEAL-T from the faucet, approves and commits, as a fresh address with no funds.", given: open, call: commitBatch(real), expect: { accepted: true, check: isNextBid(n) }, said: committed }),
          attack({ id: "bid-two", label: "The same bid with shares for a committee of two", why: "The auction is bound to its committee of three and wants one share per member.", given: open, call: commitBatch({ ...real, shareHashes: real.shareHashes.slice(0, 2), envelopes: real.envelopes.slice(0, 2) }), expect: { refused: "BadBid", args: ["share count"] } }),
          attack({ id: "set-unknown", label: "An auction with a committee nobody registered", why: "The factory call is otherwise valid: the next row sends it with the real committee.", call: create(`0x${"99".repeat(32)}`), expect: { refused: "UnknownSet", args: [`0x${"99".repeat(32)}`] } }),
          control({ id: "set-known", label: "The same call with the registered committee", why: "Gets past the committee check and stops later, at the token transfer, because nothing was approved.", call: create(cfg.committeeSetId), expect: { refused: "ERC20InsufficientAllowance" } }),
          attack({ id: "join-swapped", label: "Registering the committee with one member's encryption key swapped", why: "Member 2's ML-KEM key hash is replaced. That changes the set, so the first signature checked, member 1's, no longer fits it.", given: registrySlot, call: { to: ctx.registry, data: encodeFunctionData({ abi: committeeRegistryAbi, functionName: "registerSet", args: [threshold, swapped, deadline] }), block: before }, expect: { refused: "JoinSignatureInvalid", args: [members[0]!.account] } }),
          control({ id: "join-genuine", label: "The genuine registration at the same block", why: "The exact bytes of the registerSet transaction, one block before it landed.", given: registrySlot, call: { to: ctx.registry, data: j.data, block: before }, expect: { accepted: true, check: (d) => (d.toLowerCase() === ctx.committeeSetId.toLowerCase() ? undefined : "another set id came back") }, said: (d) => `accepted: set ${d.slice(0, 10)}…` }),
          { kind: "local", id: "cards-swapped", role: "attack", label: "In this browser: members 1 and 2's cards swapped", why: "What the bid page does before it seals: each card must match the hash its member signed on chain.", run: refuseSwappedCards },
          call({ id: "bid-junk", role: "limit", label: "Three envelopes addressed to nobody", why: "The contract cannot look inside an envelope, so it accepts this. Such a bid never opens: it is excluded and its escrow refunded, and it burns the bond if all three members released.", given: open, call: commitBatch(junk(3)), expect: { accepted: true, check: isNextBid(n) }, said: committed }),
        ];
        return steps;
      },
      limits: ["No call can make the contract refuse a bid sealed for a different committee of three: envelopes are opaque to it by design. The bidder's own browser is what refuses, and the last two rows show both sides."],
    },
    {
      id: "now",
      title: "At the latest block, straight to pqcVerify",
      question: "And without any history?",
      steps: async () => {
        const g = await release1();
        const key = await memberKey(ctx.client, g.from);
        if (!key) throw new Error("member 1 has no usable ML-DSA-87 key on chain now");
        const message = toHex(releaseAuthMessage({ chainId: BigInt(JUDGE.chainId), auction: A, member: g.from, bidCount: g.shares.length, shares: g.shares, invalidBitmap: g.invalidBitmap, deadline: g.deadline }));
        const ask = (sig: Hex): Call => ({
          to: PQC_VERIFY,
          data: encodeFunctionData({
            abi: [{ type: "function", name: "pqcVerify", stateMutability: "view", inputs: [{ name: "pubkey", type: "bytes" }, { name: "signature", type: "bytes" }, { name: "message", type: "bytes" }], outputs: [{ type: "bool" }] }],
            functionName: "pqcVerify",
            args: [toHex(key), sig, message],
          }),
        });
        const answer = (d: Hex) => (d.length === 66 ? decodeAbiParameters([{ type: "bool" }], d)[0] : undefined);
        const says = (d: Hex) => (answer(d) === undefined ? "no answer" : `pqcVerify answers ${answer(d)}`);
        const wants = (v: boolean): Expect => ({ accepted: true, check: (d) => (answer(d) === v ? undefined : says(d)) });
        return [
          control({ id: "now-genuine", label: "Member 1's release signature", why: "Key from pqcKeyStatus now; the 256-byte message rebuilt in this browser.", call: ask(g.signature), expect: wants(true), said: says }),
          attack({ id: "now-byte", label: "The same signature with one byte changed", why: "The precompile answers false; a contract turns that into its own revert.", call: ask(flipByte(g.signature, 2000)), expect: wants(false), said: says }),
          attack({ id: "now-forged", label: "The outsider's valid signature", why: "Right message, wrong signer.", call: ask(FORGED.signature), expect: wants(false), said: says }),
        ];
      },
      limits: ["A precompile has no error names: it answers true or false. The named refusals are in the attempts above."],
    },
  ];
}

/** Seal a real bid for the batch's address, and the check that refuses a tampered committee. Loaded only when asked for. */
async function sealing(
  ctx: JudgeContext,
  cfg: { reservePrice: bigint; tickSize: bigint; numTicks: number; saleDecimals: number; totalSupply: bigint },
  threshold: number,
) {
  const [{ checkCommittee, resolveCommittee }, { sealBid }, cards] = await Promise.all([import("./committee.ts"), import("./bid.ts"), ctx.cards()]);
  const opts = { rest: ctx.rest, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) };
  const { committee, recipients } = await checkCommittee(ctx.client, ctx.registry, ctx.committeeSetId, { ...opts, bundled: cards });
  const quantity = 10n ** BigInt(cfg.saleDecimals);
  const terms = { reservePrice: cfg.reservePrice, tickSize: cfg.tickSize, saleDecimals: cfg.saleDecimals };
  const need = escrowNeeded(terms, quantity, 0);
  const most = escrowNeeded(terms, cfg.totalSupply, cfg.numTicks - 1);
  const c = sealBid({ chainId: BigInt(JUDGE.chainId), auction: ctx.openAuction, bidder: BATCH, seq: 0n, quantity, tick: 0, recipients, threshold });
  const refuseSwappedCards = async () => {
    const [m1, m2, ...rest] = committee.members;
    try {
      await resolveCommittee({ ...committee, members: [{ ...m1!, card: m2!.card }, { ...m2!, card: m1!.card }, ...rest] }, { client: ctx.client, ...opts });
      return { ok: false, said: "the swapped cards were accepted" };
    } catch (err) {
      const said = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      // Only a verdict on the card counts: an unreachable endpoint must not read as a refusal.
      const code = (err as { code?: unknown }).code;
      if (code !== "CARD_INVALID" && !/recipient card does not match/.test(said)) throw err;
      return { ok: true, said: `refused: ${said}` };
    }
  };
  return { real: { ...c, escrow: escrowChoice("bucket", need, most, 18) }, refuseSwappedCards };
}

function flipByte(h: Hex, at: number): Hex {
  const b = hexToBytes(h);
  b[at]! ^= 1;
  return toHex(b);
}
