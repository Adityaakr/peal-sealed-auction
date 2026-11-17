/**
 * guest.ts - a testnet account that lives in this browser.
 *
 * Adapted from Peal Tender's apps/dashboard/src/wallet/guest.ts (the minimum,
 * copied rather than shared through qore-pq-kit: it is page code bound to each
 * app's config and storage key, not a toolkit API).
 *
 * QoreChain admits an EVM transaction only from an account with a registered
 * ML-DSA-87 key and a live authorisation window, opened by a hybrid-signed
 * (secp256k1 + ML-DSA-87) native message. A browser wallet such as MetaMask cannot
 * make that signature, and QoreX does not send EVM transactions for pages yet. So a
 * visitor who wants to bid gets a guest account: a fresh mnemonic from the
 * browser's random source (never derived from a wallet signature), held in this
 * browser's storage only, with both keys derived by @qorechain/sdk. It registers
 * its post-quantum key, opens a window scoped to the contracts it calls, sends,
 * and closes the window if anything is left of it, as the CLI does.
 *
 * Testnet only, for trying the app: the page warns, offers a backup, and can
 * forget it. Committee members never use this; their keys stay with them.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { UnifiedAccount } from "@qorechain/sdk";

const STORE = "peal-sealed-auction.guest.v1";

/** Where the guest talks to. Set once per page by the page's config. */
export interface GuestNet {
  local: boolean;
  chainId: string;
  evmChainId: number;
  evmRpc: string;
  rest: string;
  cometRpc: string;
}

let net: GuestNet | undefined;
let client: PublicClient | undefined;

export function configure(n: GuestNet): void {
  net = n;
  client = createPublicClient({ chain: chainOf(n), transport: http(n.evmRpc) }) as PublicClient;
}

function need(): GuestNet {
  if (!net) throw new Error("wallet not configured");
  return net;
}

export function evm(): PublicClient {
  need();
  return client!;
}

function chainOf(n: GuestNet) {
  return {
    id: n.evmChainId,
    name: n.local ? "Local (anvil)" : "QoreChain testnet",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [n.evmRpc] } },
  };
}

/** Testnet fees, as the kit uses them: a fixed native fee, EVM at up to 200 gwei. */
const NATIVE_FEE = { amount: [{ denom: "uqor", amount: "150000" }], gas: "1000000" };
const MAX_FEE_PER_GAS = 200_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 12_500_000_000n;

export interface GuestStatus {
  evm: Address;
  cosmos: string;
  /** Native balance in uqor (testnet) or the EVM balance in wei (local). */
  qor: bigint;
  qorDecimals: number;
  keyRegistered: boolean;
  keyIsOurs: boolean;
}

export interface Call {
  to: Address;
  data: Hex;
  label: string;
}

export type Log = (line: string) => void;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function savedMnemonic(): string | undefined {
  try {
    return storage()?.getItem(STORE) ?? undefined;
  } catch {
    return undefined;
  }
}

async function sdk() {
  return import("@qorechain/sdk");
}

let cached: { mnemonic: string; acc: UnifiedAccount } | undefined;

export async function account(): Promise<UnifiedAccount | undefined> {
  const m = savedMnemonic();
  if (!m) return undefined;
  if (cached?.mnemonic === m) return cached.acc;
  const acc = await (await sdk()).deriveUnifiedAccount(m, 0);
  cached = { mnemonic: m, acc };
  return acc;
}

export async function create(): Promise<UnifiedAccount> {
  const m = (await sdk()).generateMnemonic(256);
  storage()?.setItem(STORE, m);
  if (savedMnemonic() !== m) throw new Error("This browser does not allow the page to keep an account (storage is blocked).");
  return (await account())!;
}

export async function importMnemonic(m: string): Promise<UnifiedAccount> {
  const s = await sdk();
  const words = m.trim().split(/\s+/).join(" ");
  if (!s.validateMnemonic(words)) throw new Error("That is not a valid recovery phrase.");
  storage()?.setItem(STORE, words);
  return (await account())!;
}

export function forget(): void {
  storage()?.removeItem(STORE);
  cached = undefined;
}

// ---------------------------------------------------------------- reading

async function getJson<T>(path: string): Promise<T | undefined> {
  const r = await fetch(`${need().rest}${path}`);
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`QoreChain REST ${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function status(acc: UnifiedAccount): Promise<GuestStatus> {
  const n = need();
  if (n.local) {
    const wei = await evm().getBalance({ address: acc.evm as Address });
    return { evm: acc.evm as Address, cosmos: acc.cosmos, qor: wei, qorDecimals: 18, keyRegistered: true, keyIsOurs: true };
  }
  const s = await sdk();
  const [bal, pqc] = await Promise.all([
    getJson<{ balances: { denom: string; amount: string }[] }>(`/cosmos/bank/v1beta1/balances/${acc.cosmos}`),
    s.fetchPqcStatus({ rest: n.rest, address: acc.cosmos }),
  ]);
  const uqor = BigInt(bal?.balances.find((b) => b.denom === "uqor")?.amount ?? "0");
  return {
    evm: acc.evm as Address,
    cosmos: acc.cosmos,
    qor: uqor,
    qorDecimals: 6,
    keyRegistered: pqc.registered,
    keyIsOurs: pqc.registered ? s.isRegisteredPqcKey(pqc, acc.pqc.publicKey) !== false : false,
  };
}

/** Enough QOR to try one bid? */
export function funded(st: GuestStatus): boolean {
  return st.qor >= (st.qorDecimals === 18 ? 10n ** 17n : 600_000n);
}

// ---------------------------------------------------------------- native (hybrid-signed) transactions

let lastResult: unknown;

async function broadcast(
  acc: UnifiedAccount,
  messages: { typeUrl: string; value: unknown }[],
  mode: "hybrid" | "classical" = "hybrid",
  registry?: import("@cosmjs/proto-signing").Registry,
  fee: { amount: { denom: string; amount: string }[]; gas: string } = NATIVE_FEE,
) {
  const n = need();
  const s = await sdk();
  const { StargateClient } = await import("@cosmjs/stargate");
  const a = await getJson<{ account?: Record<string, unknown> }>(`/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  const base = (a?.account?.base_account ?? a?.account ?? {}) as Record<string, string>;
  const signer = new s.EthNativeSigner(acc, { signMode: mode, rest: n.rest, ...(registry ? { registry } : {}) });
  const transport = await StargateClient.connect(n.cometRpc);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: n.chainId,
      accountNumber: BigInt(base.account_number ?? "0"),
      sequence: BigInt(base.sequence ?? "0"),
      fee,
      messages: messages as never,
    });
    if (res.code !== 0) throw new Error(`transaction ${res.transactionHash} failed (code ${res.code}): ${res.rawLog ?? ""}`);
    lastResult = res;
    return res.transactionHash as string;
  } finally {
    transport.disconnect();
  }
}

/** Register the account's ML-DSA-87 key with a proof of possession (the one message the chain takes classically signed). */
export async function registerKey(acc: UnifiedAccount, log: Log): Promise<void> {
  const n = need();
  if (n.local) return;
  const s = await sdk();
  const st = await status(acc);
  if (st.keyRegistered) {
    if (!st.keyIsOurs) throw new Error("A different post-quantum key is registered for this account.");
    return;
  }
  if (st.qor < 300_000n) throw new Error("The account needs test QOR first: about 1 QOR covers its key, the faucet claim and one bid.");
  log("Registering your ML-DSA-87 key on chain…");
  const proof = s.signProofOfPossession({ chainId: n.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = s.buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: proof });
  const tx = await broadcast(acc, [msg], "classical");
  log(`Key registered (tx ${tx.slice(0, 10)}…).`);
}

/**
 * Buy `want` fUSD on the testnet AMM with QOR and convert it to the ERC-20 the
 * auction pulls, in one hybrid-signed transaction (`client/amm.ts`). Returns the
 * quote it used and the transaction hash.
 */
export async function buyOnAmm(acc: UnifiedAccount, erc20: Address, want: bigint, log: Log): Promise<{ amountIn: bigint; tx: string }> {
  const n = need();
  if (n.local) throw new Error("The local chain has no AMM.");
  await registerKey(acc, log);
  const amm = await import("../../../../client/amm.ts");
  const denom = amm.bankDenomOf(erc20);
  const pool = amm.findPool(await amm.fetchPools(n.rest), "uqor", denom);
  if (!pool) throw new Error("No QOR pool for this token on the testnet AMM.");
  const q = amm.quoteBuy(pool, "uqor", denom, want);
  const st = await status(acc);
  if (st.qor < q.amountIn + 400_000n) throw new Error(`Buying needs about ${Number(q.amountIn + 400_000n) / 1e6} QOR; this account holds ${Number(st.qor) / 1e6}.`);
  log(`Buying on the AMM (pool ${pool.id}): at most ${Number(q.amountIn) / 1e6} QOR in, swap and convert in one transaction…`);
  const tx = await broadcast(acc, amm.buyMessages(acc.cosmos, acc.evm as Address, q), "hybrid", amm.ammRegistry());
  log(`Bought and converted (tx ${tx.slice(0, 10)}…).`);
  return { amountIn: q.amountIn, tx };
}

/**
 * Bid with MetaMask through this guest account (`client/linked-key.ts`). The
 * guest is the post-quantum owner: once, it links the MetaMask address under a
 * spending rule for this auction (MetaMask signs the link message). Then MetaMask
 * signs each call (EIP-191) and the guest relays them as MsgExecuteEVM, hybrid-
 * signed, with no EVM window. Each call's own outcome is checked.
 */
export async function runWithMetaMask(
  acc: UnifiedAccount,
  mm: { provider: import("../../../../client/linked-key.ts").Eip1193; address: Address },
  scope: { auction: Address; token: Address; faucet?: Address; perBid: bigint; daily: bigint },
  calls: Call[],
  log: Log,
): Promise<string> {
  const n = need();
  if (n.local) throw new Error("The local chain has no smart accounts; use the guest account directly.");
  await registerKey(acc, log);
  const lk = await import("../../../../client/linked-key.ts");
  const s = await sdk();
  const { linked } = await s.fetchAuthNonce({ rest: n.rest, address: acc.cosmos, pubkey: mm.address });
  const { rules } = await lk.readLink(n.rest, acc.cosmos);
  const want = lk.bidRule(scope);
  const ruleOk = JSON.stringify(rules ?? {}).toLowerCase().includes(`${scope.auction.toLowerCase()}/${lk.SELECTORS.commitBid}`);
  if (!linked || !ruleOk) {
    log(`Linking MetaMask ${mm.address.slice(0, 10)}… to this account: it may claim from the demo faucet, approve the auction's token and bid in this auction only, capped per call and per day, for 24 hours. Confirm the link message in MetaMask…`);
    const msgs = await lk.linkMetaMaskMsgs({ provider: mm.provider, address: mm.address, owner: acc.cosmos, chainId: n.chainId, rule: want, expiryUnix: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600) });
    const tx = await broadcast(acc, msgs, "hybrid");
    log(`MetaMask linked for 24 hours (tx ${tx.slice(0, 10)}…).`);
  }
  log(`Sign ${calls.length} call${calls.length > 1 ? "s" : ""} in MetaMask (one prompt each)…`);
  const signed = await lk.metaMaskCalls({
    provider: mm.provider,
    address: mm.address,
    owner: acc.cosmos,
    relayer: acc.cosmos,
    chainId: n.chainId,
    rest: n.rest,
    calls: calls.map((c) => ({ to: c.to, data: c.data, gasLimit: 900_000n })),
  });
  log("Relaying them from this account (hybrid-signed, no window)…");
  // The relay carries the EVM execution of every call: allow 3M gas (the auction's commit is about 450k).
  const tx = await broadcast(acc, signed, "hybrid", undefined, { amount: [{ denom: "uqor", amount: "450000" }], gas: "3000000" });
  const results = lk.executionResults(lastResult as never);
  results.forEach((r, i) => log(`${calls[i]?.label ?? `call ${i + 1}`}: ${r.success ? "done" : `refused: ${r.error}`}`));
  if (results.length !== calls.length || results.some((r) => !r.success)) throw new Error(`a MetaMask call was refused (tx ${tx})`);
  return tx;
}

// ---------------------------------------------------------------- EVM, inside a scoped window

/**
 * Send `calls` in order: register the key if needed, open a window scoped to the
 * calls' targets for exactly that many transactions, send, and close the window
 * if a transaction is left unused (a spent window needs no close, which saves a
 * fee: docs/spikes.md). Locally (anvil) there is no window to open.
 */
export async function run(acc: UnifiedAccount, calls: Call[], log: Log): Promise<TransactionReceipt[]> {
  const n = need();
  const pub = evm();
  const w = createWalletClient({ chain: chainOf(n), transport: http(n.evmRpc), account: privateKeyToAccount(acc.privateKey as Hex) });
  const GAS_CAP = 1_200_000n;
  if (!n.local) {
    await registerKey(acc, log);
    const s = await sdk();
    const { evmWindowCost } = await import("@qorechain/evm");
    const targets = [...new Set(calls.map((c) => c.to.toLowerCase()))];
    const perTx = evmWindowCost({ gas: GAS_CAP, maxFeePerGas: MAX_FEE_PER_GAS, value: 0n });
    log(`Opening a window for ${calls.length} transaction${calls.length > 1 ? "s" : ""}, scoped to ${targets.length} contract${targets.length > 1 ? "s" : ""}…`);
    await broadcast(acc, [
      s.openEvmWindowMsg({ sender: acc.cosmos, blocks: 120, maxTxs: calls.length, maxValue: perTx * BigInt(calls.length), allowedTargets: targets }),
    ]);
  }
  const out: TransactionReceipt[] = [];
  try {
    for (const c of calls) {
      log(`${c.label}…`);
      const gasEst = await pub.estimateGas({ account: acc.evm as Address, to: c.to, data: c.data });
      const gas = (gasEst * 125n) / 100n;
      if (gas > GAS_CAP) throw new Error(`${c.label} needs ${gas} gas, more than this window allows`);
      const nonce = await pub.getTransactionCount({ address: acc.evm as Address, blockTag: "pending" });
      const hash = await w.sendTransaction({
        to: c.to,
        data: c.data,
        gas,
        nonce,
        maxFeePerGas: n.local ? undefined : MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: n.local ? undefined : MAX_PRIORITY_FEE_PER_GAS,
      });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (r.status !== "success") throw new Error(`${c.label} reverted (tx ${hash})`);
      out.push(r);
      log(`${c.label}: done (tx ${hash.slice(0, 10)}…).`);
    }
  } finally {
    if (!n.local && out.length < calls.length) {
      try {
        const s = await sdk();
        const st = await s.fetchEvmWindow({ rest: n.rest, address: acc.cosmos });
        if (st.found) {
          await broadcast(acc, [s.closeEvmWindowMsg(acc.cosmos)]);
          log("Window closed.");
        }
      } catch (e) {
        log(`Could not close the window: ${e instanceof Error ? e.message : String(e)}. It expires by itself within 120 blocks.`);
      }
    }
  }
  return out;
}

/** Local node only: give the guest 10 test QOR. */
export async function fundLocal(acc: UnifiedAccount): Promise<void> {
  const n = need();
  if (!n.local) throw new Error("only on a local node");
  await fetch(n.evmRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [acc.evm, "0x8ac7230489e80000"] }),
  });
}
