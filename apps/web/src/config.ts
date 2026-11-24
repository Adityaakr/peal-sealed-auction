/**
 * config.ts - the page's network and the chain reads every page shares. Kept free
 * of the post-quantum SDK so the landing page loads light; the app pages pull the
 * SDK in through common.ts.
 */
import { createPublicClient, defineChain, getAddress, http, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { sealedAuctionAbi } from "../../../client/abi.ts";
import { configureExplorer } from "./explorer.ts";
import { mountWallet } from "./wallet/panel.ts";

export interface AppConfig {
  network: "local" | "testnet";
  chainId: number;
  /** Cosmos chain id, for the guest account's native messages. */
  cosmosChainId?: string;
  /** Absolute URL, or a path on this origin (the dev server and Vercel proxy /evm, /rest and /rpc). */
  evmRpc: string;
  rest: string;
  /** CometBFT JSON-RPC, for broadcasting the guest's native messages. */
  cometRpc?: string;
  registry: Address;
  factory: Address;
  fusd: Address;
  pealt: Address;
  /** PEAL-T demo faucet: visitors claim what they bid with in the demo auction. */
  faucet?: Address;
  committeeSetId?: Hex;
  /** A copy of the committee's cards, each used only if it matches the hash its member signed on chain. */
  committeeCards?: string;
  auction?: Address;
  /** The open auction visitors are pointed at (a buyback paid in faucet PEAL-T). */
  demoAuction?: Address;
  /** Local stack only: where the harness records ML-DSA-87 verdicts for the precompile stand-in. */
  attestUrl?: string;
  /** Local stack only: throwaway accounts. */
  devAccounts?: { label: string; mnemonic: string }[];
}

const abs = (u: string) => new URL(u, location.origin).toString();
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function fetchConfig(net: string): Promise<AppConfig | undefined> {
  const res = await fetch(`./config.${net}.json`, { cache: "no-store" }).catch(() => undefined);
  if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("json")) return undefined;
  return (await res.json()) as AppConfig;
}

/**
 * The page's network: `?net=local|testnet` when given; otherwise the local
 * stack's config when served from this machine and one exists, else the testnet
 * (what a hosted copy always uses).
 */
export async function loadConfig(): Promise<AppConfig> {
  const q = new URLSearchParams(location.search);
  const asked = q.get("net");
  let cfg: AppConfig | undefined;
  if (asked === "local" || asked === "testnet") cfg = await fetchConfig(asked);
  else {
    if (LOCAL_HOSTS.has(location.hostname)) cfg = await fetchConfig("local");
    cfg ??= await fetchConfig("testnet");
  }
  if (!cfg) throw new Error(`no config for "${asked ?? "testnet"}" (run \`npm run local:stack\` for a local one)`);
  // The auction a page shows: the one in the URL, else the open demo auction, else the config's.
  const a = q.get("auction");
  cfg.auction = a ? getAddress(a) : (cfg.demoAuction ?? cfg.auction);
  cfg.evmRpc = abs(cfg.evmRpc);
  cfg.rest = abs(cfg.rest).replace(/\/+$/, "");
  cfg.cometRpc = abs(cfg.cometRpc ?? "/rpc").replace(/\/+$/, "");
  cfg.cosmosChainId ??= "qorechain-diana";
  return cfg;
}

/** Mount the wallet drawer for this page's network. */
export function startWallet(cfg: AppConfig): void {
  configureExplorer(cfg.network === "testnet" ? cfg.rest : undefined);
  mountWallet({
    local: cfg.network === "local",
    chainId: cfg.cosmosChainId!,
    evmChainId: cfg.chainId,
    evmRpc: cfg.evmRpc,
    rest: cfg.rest,
    cometRpc: cfg.cometRpc!,
    pealt: cfg.pealt,
    faucet: cfg.faucet,
  });
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

export const STATES = ["Created", "Funded", "CommitOpen", "Closed", "Settled", "Failed", "Cancelled"] as const;

export async function auctionSummary(client: PublicClient, auction: Address) {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;
  const [state, cfg, bidCount, releaseMask, threshold, members] = await Promise.all([
    read<number>("state"),
    read<{
      totalSupply: bigint;
      saleDecimals: number;
      reservePrice: bigint;
      tickSize: bigint;
      numTicks: number;
      endTime: bigint;
      releaseDeadline: bigint;
      bidBond: bigint;
      maxBids: number;
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

/** Plain-words state for people, from the contract's state name. */
export const STATE_WORDS: Record<string, string> = {
  Created: "Created",
  Funded: "Funded",
  CommitOpen: "Open for bids",
  Closed: "Closed, waiting for releases",
  Settled: "Settled",
  Failed: "Failed, everyone refunded",
  Cancelled: "Cancelled",
};

/** `?net=…` when the visitor chose a network, else nothing. */
export function netOnly(): string {
  const net = new URLSearchParams(location.search).get("net");
  return net ? `?net=${encodeURIComponent(net)}` : "";
}

/** Query string carried between pages: the network (if chosen) and the auction. */
export function carry(cfg: AppConfig, auction?: Address): string {
  const q = new URLSearchParams();
  const net = new URLSearchParams(location.search).get("net");
  if (net) q.set("net", net);
  const a = auction ?? cfg.auction;
  if (a) q.set("auction", a);
  const s = q.toString();
  return s ? `?${s}` : "";
}

