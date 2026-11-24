/**
 * Shared by the app pages: configuration, accounts, clients, the page chrome and
 * small UI helpers.
 *
 * Two kinds of account act on these pages:
 * - the **guest account** (src/wallet/): a testnet key pair made in this browser
 *   and kept in its storage, which registers its ML-DSA-87 key and opens scoped
 *   windows by itself. Visitors bid with it.
 * - a **dev account**: a mnemonic typed into the page (or one of the local
 *   stack's throwaway accounts). It stays in memory only; it is never stored,
 *   logged or sent anywhere. The demo committee and issuer use these; on the
 *   testnet the account needs a window opened with the CLI first.
 * Every key either derives (secp256k1, ML-DSA-87, ML-KEM-1024 + X25519) is used
 * in this browser only.
 */
import { deriveSealKeys, type SealKeyPair } from "@qorechain/qoreseal";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import { createWalletClient, getAddress, http, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { carry, chainOf, netOnly, publicClientOf, startWallet, type AppConfig } from "./config.ts";
import { h, hash, icon, mark } from "./ui.ts";
import { walletButton } from "./wallet/panel.ts";
import { act, closePanel, openPanel, state as wallet, subscribe } from "./wallet/store.ts";
import type { Call } from "./wallet/guest.ts";

export * from "./config.ts";

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

/** Whoever acts on a page: the browser's guest account, or a dev account. */
export type Actor = { kind: "guest"; address: Address } | { kind: "dev"; address: Address; dev: DevAccount };

/**
 * Send `calls` as the actor. A guest opens one window scoped to the calls'
 * contracts and logs each step in the wallet drawer, which closes when they all
 * succeeded and stays open on an error; a dev account sends them in
 * order (on the testnet inside a window it opened with the CLI).
 */
export async function runCalls(cfg: AppConfig, actor: Actor, title: string, calls: Call[]): Promise<Hex[]> {
  if (actor.kind === "dev") {
    const out: Hex[] = [];
    for (const c of calls) out.push(await send(cfg, actor.dev, c));
    return out;
  }
  const receipts = await act(title, calls);
  if (!receipts) throw new Error(wallet.error ?? `${title} did not complete`);
  closePanel(); // the page shows the outcome; the drawer opened for the steps would cover it
  return receipts.map((r) => r.transactionHash);
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

/** A page heading: kicker, title and one line under it. */
export function pageHead(kicker: string, title: string, sub?: string | Node): HTMLElement {
  return h("div.page-head", h("div.kicker", kicker), h("h1.page-title", title), sub ? h("p.page-sub", sub) : null);
}

/** The activity card every app page ends with. */
export function activityCard(): HTMLElement {
  return el("div", { class: "card" }, el("h2", {}, "Activity"), el("div", { id: "log" }));
}

/**
 * The "acting as" card: the browser's guest account (when `guest` is allowed),
 * or a dev account (local throwaway accounts, or a pasted testnet mnemonic).
 */
export function accountPicker(cfg: AppConfig, host: HTMLElement, onReady: (a: Actor) => void, opts: { guest?: boolean; role?: string } = {}): void {
  const allowGuest = opts.guest ?? false;
  const box = el("div", { class: "card account" });
  const who = el("div", { class: "mono who", id: "who" });
  const whoLine = el("div", { class: "who-line" }, el("span", { class: "muted small" }, "Acting as"), who);
  box.append(el("h2", {}, opts.role ? `Your account: ${opts.role}` : "Your account"), whoLine);
  let current: Actor | undefined;
  const choose = (a: Actor, label: string) => {
    current = a;
    who.textContent = a.address;
    who.setAttribute("title", label);
    onReady(a);
  };

  if (allowGuest) {
    const g = el("div", { class: "guest-row" });
    const drawGuest = () => {
      const st = wallet.guestStatus;
      if (st) {
        const use = el("button", { id: "use-guest", class: "btn btn-small" }, "Use the guest account") as HTMLButtonElement;
        use.onclick = () => choose({ kind: "guest", address: getAddress(st.evm) }, "guest account");
        const inUse = current?.kind === "guest";
        g.replaceChildren(
          el("span", { class: "small" }, "Guest account in this browser "),
          hash(st.evm, { label: "guest address" }),
          inUse ? el("span", { class: "chip ok" }, icon("check"), "in use") : use,
        );
        if (!current && cfg.network === "testnet") choose({ kind: "guest", address: getAddress(st.evm) }, "guest account");
      } else {
        const make = el("button", { class: "btn btn-small btn-primary", id: "open-wallet" }, "Create a guest account") as HTMLButtonElement;
        make.onclick = () => openPanel();
        g.replaceChildren(el("span", { class: "small muted" }, wallet.ready ? "No guest account in this browser yet. " : "Reading this browser's guest account… "), make);
      }
    };
    subscribe(drawGuest);
    drawGuest();
    box.append(g);
  }

  const dev = el("details", { class: "dev" });
  if (!allowGuest || cfg.network === "local") dev.setAttribute("open", "");
  dev.append(
    el("summary", {}, cfg.network === "local" ? "Local throwaway accounts" : "Use a dev account (a testnet mnemonic)"),
    el(
      "p",
      { class: "warn" },
      cfg.network === "local"
        ? "Accounts from the local stack. Nothing here touches a real network."
        : "Testnet only. Paste a throwaway testnet mnemonic; it stays in this tab's memory and is never stored or sent. On the testnet it needs a window opened with the CLI (npm run testnet -- window).",
    ),
  );
  const row = el("div", { class: "row" });
  let input: HTMLInputElement | HTMLSelectElement;
  if (cfg.devAccounts?.length) {
    const sel = el("select", { id: "acct", class: "input" }) as HTMLSelectElement;
    for (const a of cfg.devAccounts) sel.append(el("option", { value: a.mnemonic }, a.label));
    input = sel;
  } else {
    input = el("input", { id: "acct", class: "input", type: "password", placeholder: "24-word testnet mnemonic", autocomplete: "off" }) as HTMLInputElement;
  }
  const btn = el("button", { id: "use-account" }, "Use account") as HTMLButtonElement;
  row.append(input, btn);
  dev.append(row);
  box.append(dev);
  host.append(box);
  btn.onclick = () =>
    guard(btn, async () => {
      const d = await devAccount(cfg, input.value);
      choose({ kind: "dev", address: d.address, dev: d }, "dev account");
      logLine(`account ${d.address} ready (keys derived in this browser)`, "ok");
    });
}

// ------------------------------------------------------------------ chrome

const TABS: { file: string; label: string }[] = [
  { file: "auctions", label: "Auctions" },
  { file: "bidder", label: "Bid" },
  { file: "results", label: "Results" },
  { file: "committee", label: "Committee" },
  { file: "issuer", label: "Open an auction" },
];

/** Draw the app header (wordmark, network, wallet, tabs) and the footer, and mount the wallet. */
export function header(title: string, cfg: AppConfig): void {
  document.title = `${title} · Peal Sealed Auction`;
  const page = location.pathname.split("/").pop()?.replace(/\.html$/, "") || "auctions";
  const q = carry(cfg);
  const pill = h(
    `span.net-pill${cfg.network === "local" ? ".is-local" : ""}`,
    { title: cfg.evmRpc },
    h("span.net-dot"),
    cfg.network === "local" ? "Local node" : "QoreChain testnet",
  );
  startWallet(cfg);
  $("#top").replaceChildren(
    h(
      "div.wrap",
      h(
        "div.site-header",
        h("div.identity", h("a.wordmark", { href: `./${netOnly()}` }, mark("auction"), "Peal Sealed Auction"), h("div.tagline", "Sealed bids no single key holder can open before the close.")),
        h("div.header-meta", pill, walletButton()),
      ),
      h(
        "nav.tabs",
        { "aria-label": "Sections" },
        ...TABS.map((t) => h("a", { href: `./${t.file}.html${q}`, "aria-current": t.file === page ? "page" : undefined }, t.label)),
      ),
    ),
  );
  const foot = document.querySelector("footer.app-foot") ?? document.body.appendChild(h("footer.app-foot"));
  foot.replaceChildren(
    h(
      "div.wrap",
      h(
        "div.site-footer",
        "Bids are sealed in this browser: the plaintext never leaves the tab. A guest account, if you make one, lives only in this browser. ",
        h("a", { href: "/judge" }, "For judges"),
        " · ",
        h("a", { href: "https://github.com/Adityaakr/peal-sealed-auction", target: "_blank", rel: "noopener" }, "Source"),
        " · ",
        h("a", { href: "https://github.com/Adityaakr/peal-sealed-auction/blob/main/THREAT_MODEL.md", target: "_blank", rel: "noopener" }, "Threat model"),
      ),
    ),
  );
}

/** Show a page-level failure in words instead of a blank page. */
export function fail(err: unknown): void {
  const app = document.querySelector("#app");
  const msg = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  app?.replaceChildren(el("div", { class: "note bad" }, `This page could not load: ${msg}`));
}
