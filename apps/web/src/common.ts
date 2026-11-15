/**
 * Shared by the pages: configuration, dev accounts, clients and small UI helpers.
 *
 * Accounts are "dev accounts": a testnet or local mnemonic typed into the page
 * (or picked from the local stack's throwaway accounts). The mnemonic stays in
 * memory only; it is never stored, logged or sent anywhere. Every key it
 * derives (secp256k1, ML-DSA-87, ML-KEM-1024 + X25519) is used in this browser.
 * This mode is for the testnet demo only (design decision D8: no public bidding).
 */
import { deriveSealKeys, type SealKeyPair } from "@qorechain/qoreseal";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sealedAuctionAbi } from "../../../client/abi.ts";

export interface AppConfig {
  network: "local" | "testnet";
  chainId: number;
  /** Absolute URL, or a path on this origin (the dev server proxies /evm and /rest). */
  evmRpc: string;
  rest: string;
  registry: Address;
  factory: Address;
  fusd: Address;
  pealt: Address;
  committeeSetId?: Hex;
  auction?: Address;
  /** Local stack only: where the harness records ML-DSA-87 verdicts for the precompile stand-in. */
  attestUrl?: string;
  /** Local stack only: throwaway accounts. */
  devAccounts?: { label: string; mnemonic: string }[];
}

const abs = (u: string) => new URL(u, location.origin).toString();

export async function loadConfig(): Promise<AppConfig> {
  const q = new URLSearchParams(location.search);
  const net = q.get("net") ?? "local";
  const res = await fetch(`./config.${net === "testnet" ? "testnet" : "local"}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`no config for "${net}" (run \`npm run local:stack\` for a local one)`);
  const cfg = (await res.json()) as AppConfig;
  const a = q.get("auction");
  if (a) cfg.auction = getAddress(a);
  cfg.evmRpc = abs(cfg.evmRpc);
  cfg.rest = abs(cfg.rest).replace(/\/+$/, "");
  return cfg;
}

export function chainOf(cfg: AppConfig): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.network === "local" ? "Local (anvil)" : "QoreChain Testnet",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [cfg.evmRpc] } },
  });
}

export function publicClientOf(cfg: AppConfig): PublicClient {
  return createPublicClient({ chain: chainOf(cfg), transport: http(cfg.evmRpc) }) as PublicClient;
}

export interface DevAccount {
  acc: UnifiedAccount;
  address: Address;
  seal: SealKeyPair;
  wallet: WalletClient;
}

export async function devAccount(cfg: AppConfig, mnemonic: string): Promise<DevAccount> {
  const m = mnemonic.trim().split(/\s+/).join(" ");
  const acc = await deriveUnifiedAccount(m, 0);
  const wallet = createWalletClient({
    account: privateKeyToAccount(acc.privateKey as Hex),
    chain: chainOf(cfg),
    transport: http(cfg.evmRpc),
  });
  return { acc, address: getAddress(acc.evm), seal: deriveSealKeys({ mnemonic: m }), wallet };
}

/** Send and wait. On QoreChain the sender needs a live EVM window (open it with the kit CLI). */
export async function send(cfg: AppConfig, d: DevAccount, tx: { to: Address; data: Hex }): Promise<Hex> {
  const client = publicClientOf(cfg);
  const fees = cfg.network === "testnet" ? { maxFeePerGas: 200_000_000_000n, maxPriorityFeePerGas: 12_500_000_000n } : {};
  const gas = cfg.network === "testnet" ? ((await client.estimateGas({ account: d.address, ...tx })) * 125n) / 100n : 30_000_000n;
  const hash = await d.wallet.sendTransaction({ account: d.wallet.account!, chain: d.wallet.chain, ...tx, gas, ...fees });
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return hash;
}

export const STATES = ["Created", "Funded", "CommitOpen", "Closed", "Settled", "Failed", "Cancelled"] as const;

export async function auctionSummary(client: PublicClient, auction: Address) {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;
  const [state, cfg, bidCount, releaseMask, threshold, members] = await Promise.all([
    read<number>("state"),
    read<{
      totalSupply: bigint;
      reservePrice: bigint;
      tickSize: bigint;
      numTicks: number;
      endTime: bigint;
      releaseDeadline: bigint;
      bidBond: bigint;
      saleToken: Address;
      quoteToken: Address;
      issuer: Address;
      committeeSetId: Hex;
    }>("config"),
    read<number>("bidCount"),
    read<number>("releaseMask"),
    read<number>("threshold"),
    read<readonly Address[]>("members"),
  ]);
  return { state: STATES[Number(state)]!, cfg, bidCount: Number(bidCount), releaseMask: Number(releaseMask), threshold: Number(threshold), members };
}

// ------------------------------------------------------------------ UI

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function el(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export function short(h: string, n = 10): string {
  return h.length <= 2 * n + 2 ? h : `${h.slice(0, n + 2)}…${h.slice(-n)}`;
}

export function fmt(v: bigint, decimals: number, places = 4): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = decimals ? s.slice(-decimals).slice(0, places).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/** Append a line to the page's activity log. `kind` is ok | bad | info. */
export function logLine(text: string, kind: "ok" | "bad" | "info" = "info"): void {
  const log = $("#log");
  log.prepend(el("div", { class: `line ${kind}` }, `${new Date().toLocaleTimeString()}  ${text}`));
}

export async function guard(btn: HTMLButtonElement, f: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  try {
    await f();
  } catch (err) {
    logLine(err instanceof Error ? err.message.split("\n")[0]! : String(err), "bad");
  } finally {
    btn.disabled = false;
  }
}

/** The account picker: local throwaway accounts, or a pasted testnet mnemonic. */
export function accountPicker(cfg: AppConfig, host: HTMLElement, onReady: (d: DevAccount) => void): void {
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, "Dev account"));
  box.append(
    el(
      "p",
      { class: "warn" },
      cfg.network === "local"
        ? "Local throwaway accounts from the local stack."
        : "Testnet only. Paste a throwaway testnet mnemonic. It stays in this tab's memory and is never stored or sent.",
    ),
  );
  const row = el("div", { class: "row" });
  let input: HTMLInputElement | HTMLSelectElement;
  if (cfg.devAccounts?.length) {
    const sel = el("select", { id: "acct" }) as HTMLSelectElement;
    for (const a of cfg.devAccounts) sel.append(el("option", { value: a.mnemonic }, a.label));
    input = sel;
  } else {
    input = el("input", { id: "acct", type: "password", placeholder: "24-word testnet mnemonic", autocomplete: "off" }) as HTMLInputElement;
  }
  const btn = el("button", { id: "use-account" }, "Use account") as HTMLButtonElement;
  const who = el("div", { class: "mono", id: "who" });
  row.append(input, btn);
  box.append(row, who);
  host.append(box);
  btn.onclick = () =>
    guard(btn, async () => {
      const d = await devAccount(cfg, input.value);
      who.textContent = d.address;
      logLine(`account ${d.address} ready (keys derived in this browser)`, "ok");
      onReady(d);
    });
}

export function header(title: string, cfg: AppConfig): void {
  const q = location.search;
  document.title = title;
  $("#top").replaceChildren(
    el("strong", {}, "Peal Sealed Auction"),
    el("a", { href: `./index.html${q}` }, "Home"),
    el("a", { href: `./issuer.html${q}` }, "Issue"),
    el("a", { href: `./bidder.html${q}` }, "Bid"),
    el("a", { href: `./committee.html${q}` }, "Committee"),
    el("a", { href: `./results.html${q}` }, "Results"),
    el("span", { class: "net" }, `${cfg.network} · chain ${cfg.chainId}`),
  );
}
