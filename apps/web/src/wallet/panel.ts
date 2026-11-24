/**
 * panel.ts - the wallet drawer: a guest account (the one that bids), QoreX
 * (identity and funding the guest), MetaMask (identity and network), and the
 * running log of each step. Adapted from Peal Tender's apps/dashboard/src/wallet/panel.ts.
 */
import { encodeFunctionData, parseAbi, parseUnits, type Address } from "viem";
import { explorerLink, explorerOn, EXPLORER_NOTE } from "../explorer.ts";
import { amount, chip, h, hash, icon } from "../ui.ts";
import * as guest from "./guest.ts";
import * as metamask from "./metamask.ts";
import * as qorex from "./qorex.ts";
import { act, emit, log, refreshGuest, setPanel, state, subscribe } from "./store.ts";

export const DASHBOARD_FAUCET = "https://dashboard.qorechain.io/faucet";
export const QOREX_HELP = "https://docs.qorechain.io/qorex/browser-extension";

export interface WalletConfig extends guest.GuestNet {
  /** The PEAL-T demo token and its faucet (1,000 per address per day). */
  pealt?: Address;
  faucet?: Address;
}

const faucetAbi = parseAbi([
  "function claim(uint256 amount)",
  "function claimableBy(address who) view returns (uint256 amount, uint64 availableAt)",
]);
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

let cfg: WalletConfig | undefined;
let root: HTMLElement | undefined;
let open = false;
let showPhrase = false;
let pealtBal: bigint | undefined;
let lastFocus: Element | null = null;
/** When the "Copied" word on the address button goes back (the drawer redraws often). */
let copiedUntil = 0;

/** Configure the wallet for this page's network and mount the drawer. */
export function mountWallet(c: WalletConfig): void {
  cfg = c;
  guest.configure(c);
  root = h("aside.wallet", { "aria-label": "Wallet", "aria-hidden": "true", role: "dialog", id: "wallet" });
  const scrim = h("div.wallet-scrim");
  scrim.addEventListener("click", () => setOpen(false));
  document.body.append(scrim, root);
  setPanel(() => setOpen(true), () => setOpen(false));
  subscribe(() => {
    draw();
    void refreshToken();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });
  draw();
  void refreshGuest();
}

export function setOpen(v: boolean): void {
  if (v && !open) lastFocus = document.activeElement;
  open = v;
  document.body.classList.toggle("wallet-open", v);
  root?.setAttribute("aria-hidden", v ? "false" : "true");
  draw();
  if (v) (root?.querySelector(".wallet-head button") as HTMLElement | null)?.focus();
  else if (lastFocus instanceof HTMLElement) lastFocus.focus();
}

/** PEAL-T held by the guest (undefined until read). */
export function guestPealt(): bigint | undefined {
  return pealtBal;
}

let tokenReading = false;
async function refreshToken(): Promise<void> {
  if (!state.guest || !cfg?.pealt || tokenReading) return;
  tokenReading = true;
  try {
    const b = (await guest.evm().readContract({ address: cfg.pealt, abi: balAbi, functionName: "balanceOf", args: [state.guest.evm as Address] })) as bigint;
    if (b !== pealtBal) {
      pealtBal = b;
      emit();
    }
  } catch {
    // shown as unknown
  } finally {
    tokenReading = false;
  }
}

/** Claim 1,000 PEAL-T from the demo faucet with the guest account. */
export async function claimPealt(): Promise<boolean> {
  if (!cfg?.faucet) return false;
  const max = parseUnits("1000", 18);
  if (state.guest) {
    const [can, at] = (await guest.evm().readContract({ address: cfg.faucet, abi: faucetAbi, functionName: "claimableBy", args: [state.guest.evm as Address] })) as [bigint, bigint];
    if (can === 0n) {
      state.error = at > 0n ? `The faucet gives each address 1,000 PEAL-T a day; yours can claim again at ${new Date(Number(at) * 1000).toUTCString().slice(5, 22)} UTC.` : "The faucet is empty.";
      emit();
      return false;
    }
  }
  const ok = await act("Get 1,000 test PEAL-T", [
    { to: cfg.faucet, data: encodeFunctionData({ abi: faucetAbi, functionName: "claim", args: [max] }), label: "Claim 1,000 PEAL-T from the demo faucet" },
  ]);
  void refreshToken();
  return Boolean(ok);
}

/** The header button: "Connect" or the guest's short address. */
export function walletButton(): HTMLElement {
  const b = h("button.btn.btn-small.wallet-btn", { type: "button", "aria-haspopup": "dialog", "aria-controls": "wallet" });
  fillButton(b);
  b.addEventListener("click", () => setOpen(true));
  return b;
}

function fillButton(b: Element): void {
  const g = state.guestStatus;
  b.replaceChildren(icon("wallet"), g ? `${g.evm.slice(0, 6)}…${g.evm.slice(-4)}` : state.qorex ? "QoreX connected" : "Connect");
}

function section(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h("section.wallet-section", h("h3", title), ...children);
}

/** The whole native address, to copy into the faucet, with which address it is and what to do with it. */
function fundingAddress(native: string): HTMLElement {
  const copied = () => Date.now() < copiedUntil;
  const b = h("button.btn.btn-small", { type: "button", id: "copy-native" }, icon(copied() ? "check" : "copy"), copied() ? "Copied" : "Copy qor1 address");
  const code = h("code.native-addr", { id: "native-address" }, native);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(native);
      copiedUntil = Date.now() + 2_000;
      setTimeout(draw, 2_050);
      draw();
      document.getElementById("copy-native")?.focus();
    } catch {
      // No clipboard here: select the address so it can be copied by hand.
      const r = document.createRange();
      r.selectNodeContents(code);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
    }
  });
  return h(
    "div.fund-addr",
    code,
    b,
    h("p.small.muted", "The dashboard faucet asks you to sign in. Give it this native ", h("strong", "qor1…"), " address, not the 0x one, then come back and press ", h("strong", "Check balance"), "."),
  );
}

function guestSection(): HTMLElement {
  const g = state.guestStatus;
  if (!state.guest || !g) {
    const ta = h("textarea.input", { rows: 3, placeholder: "24-word recovery phrase", "aria-label": "recovery phrase" }) as HTMLTextAreaElement;
    ta.style.minHeight = "70px";
    const create = h("button.btn.btn-primary", { type: "button", id: "guest-create" }, icon("key"), "Create a guest account");
    create.addEventListener("click", async () => {
      create.setAttribute("disabled", "");
      state.error = undefined;
      try {
        await guest.create();
        await refreshGuest();
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        create.removeAttribute("disabled");
        emit();
      }
    });
    const imp = h("button.btn.btn-small", { type: "button" }, "Import");
    imp.addEventListener("click", async () => {
      try {
        await guest.importMnemonic(ta.value);
        await refreshGuest();
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        emit();
      }
    });
    return section(
      "Guest account",
      h(
        "p.small.muted",
        "A fresh testnet account made in this browser, with its own ML-DSA-87 key. It is what places your bids: it registers its post-quantum key, then opens a short window scoped to the contracts it calls, as QoreChain requires.",
      ),
      state.ready ? create : h("p.small.muted", "Reading this browser's saved account…"),
      h("details.small", { style: "margin-top:10px" }, h("summary", "I have a recovery phrase"), h("div", { style: "margin-top:8px;display:grid;gap:8px" }, ta, imp)),
    );
  }

  const isFunded = guest.funded(g);
  const fundRow = h("div.wallet-actions");
  if (cfg?.local) {
    const b = h("button.btn.btn-small", { type: "button", id: "guest-fund-local" }, "Add 10 test QOR (local node)");
    b.addEventListener("click", async () => {
      await guest.fundLocal(state.guest!);
      await refreshGuest();
    });
    fundRow.append(b);
  } else {
    if (state.qorex) {
      const amt = h("input.input", { value: "1", "aria-label": "QOR to send", style: "width:70px;min-height:30px;padding:4px 8px" }) as HTMLInputElement;
      const b = h("button.btn.btn-small.btn-primary", { type: "button" }, "Send from QoreX");
      b.addEventListener("click", async () => {
        try {
          const uqor = parseUnits(amt.value.trim() || "0", 6);
          log(`Asking QoreX to send ${amt.value} QOR to your guest account…`);
          const sent = await qorex.sendQor(state.qorex!.cosmos, g.cosmos, uqor);
          log(`QoreX sent it (tx ${sent.txHash.slice(0, 10)}…, ${sent.shield === "shielded" ? "hybrid ML-DSA-87 layer confirmed by QoreX" : `QoreX shield check: ${sent.shield}`}).`, sent.txHash);
          setTimeout(() => void refreshGuest(), 4000);
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
          emit();
        }
      });
      fundRow.append(amt, b);
    }
    fundRow.append(h("a.btn.btn-small", { href: DASHBOARD_FAUCET, target: "_blank", rel: "noopener" }, "Dashboard faucet", icon("out")));
    const refresh = h("button.btn.btn-small", { type: "button" }, "Check balance");
    refresh.addEventListener("click", () => void refreshGuest());
    fundRow.append(refresh);
  }

  const tokenRow = h("div.wallet-actions");
  if (cfg?.faucet) {
    const b = h("button.btn.btn-small", { type: "button", id: "guest-get-pealt", disabled: state.busy ? true : undefined }, "Get 1,000 test PEAL-T");
    b.addEventListener("click", () => void claimPealt());
    tokenRow.append(b);
  }

  const phrase = h("div");
  if (showPhrase) {
    phrase.append(
      h("div.note.warn", { style: "margin-top:8px" }, "Anyone with this phrase controls this test account. Keep it to restore the account in another browser; never use it for real funds."),
      h("pre.code", { style: "white-space:pre-wrap;margin-top:8px" }, guest.savedMnemonic() ?? ""),
    );
  }
  const toggle = h("button.btn.btn-small", { type: "button" }, showPhrase ? "Hide recovery phrase" : "Back up");
  toggle.addEventListener("click", () => {
    showPhrase = !showPhrase;
    draw();
  });
  const forget = h("button.btn.btn-small", { type: "button" }, "Forget");
  forget.addEventListener("click", () => {
    if (!confirm("Forget this guest account in this browser? Without its recovery phrase it cannot be restored.")) return;
    guest.forget();
    showPhrase = false;
    pealtBal = undefined;
    void refreshGuest();
  });

  return section(
    "Guest account",
    h(
      "dl.kv",
      h("dt", "Address"),
      h("dd", hash(g.evm, { label: "guest EVM address" })),
      cfg?.local ? null : h("dt", "Native"),
      cfg?.local ? null : h("dd", hash(g.cosmos, { label: "guest qor address" })),
      h("dt", "Balance"),
      h("dd", { id: "guest-qor" }, `${amount(g.qor, g.qorDecimals, 3)} QOR `, isFunded ? null : chip("needs QOR", "warn")),
      h("dt", "PEAL-T"),
      h("dd", { id: "guest-pealt" }, pealtBal === undefined ? "…" : amount(pealtBal, 18, 2)),
      h("dt", "PQ key"),
      h("dd", cfg?.local ? chip("Local node: not needed", "plain") : g.keyRegistered ? (g.keyIsOurs ? chip("Registered", "ok") : chip("Another key", "bad")) : chip("Registers on first action", "wait")),
    ),
    h("div.small.muted", { style: "margin-top:12px" }, cfg?.local ? "1. Fund it" : "1. Fund it: about 1 QOR covers the key, the faucet claim and one bid"),
    cfg?.local ? null : fundingAddress(g.cosmos),
    fundRow,
    cfg?.faucet ? h("div.small.muted", { style: "margin-top:12px" }, "2. Get PEAL-T to bid with in the demo auction") : null,
    cfg?.faucet ? tokenRow : null,
    h("div.wallet-actions", { style: "margin-top:14px" }, toggle, forget),
    phrase,
  );
}

function qorexSection(): HTMLElement {
  if (state.qorex) {
    return section(
      "QoreX",
      h("dl.kv", h("dt", "Native"), h("dd", hash(state.qorex.cosmos, { label: "QoreX address" })), state.qorex.evm ? h("dt", "EVM") : null, state.qorex.evm ? h("dd", hash(state.qorex.evm, { label: "QoreX EVM address" })) : null),
      h("p.small.muted", "QoreX funds your guest account with one transfer you approve in QoreX. It cannot send contract calls for pages yet, so the guest account places the bid."),
    );
  }
  const b = h("button.btn", { type: "button", disabled: qorex.available() ? undefined : true }, "Connect QoreX");
  b.addEventListener("click", async () => {
    try {
      state.qorex = await qorex.connect();
      emit();
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      emit();
    }
  });
  return section(
    "QoreX",
    h("p.small.muted", "QoreChain's own wallet. Connect it to fund your guest account straight from QoreX."),
    b,
    qorex.available() ? null : h("p.small", { style: "margin:8px 0 0" }, "Not found in this browser. ", h("a", { href: QOREX_HELP, target: "_blank", rel: "noopener" }, "Get QoreX")),
  );
}

function metamaskSection(): HTMLElement {
  if (state.metamask) {
    return section(
      state.metamask.wallet,
      h("dl.kv", h("dt", "Address"), h("dd", hash(state.metamask.address, { label: "MetaMask address" })), h("dt", "Network"), h("dd", state.metamask.onQoreChain ? chip("QoreChain testnet", "ok") : chip("Not switched", "warn"))),
      h("p.small.muted", "QoreChain accepts an EVM transaction only with a post-quantum key and a window, which MetaMask cannot make, so bids go through your guest account."),
    );
  }
  const name = metamask.available();
  const b = h("button.btn", { type: "button", disabled: name ? undefined : true }, `Connect ${name ?? "MetaMask"}`);
  b.addEventListener("click", async () => {
    try {
      state.metamask = await metamask.connect(cfg!.evmChainId, cfg!.evmRpc);
      emit();
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      emit();
    }
  });
  return section("MetaMask", h("p.small.muted", "Connects and adds the QoreChain testnet network. It cannot sign for QoreChain by itself; on the bid page it can sign bids through your guest account, which links it under a spending rule for that one auction."), b, name ? null : h("p.small.muted", { style: "margin:8px 0 0" }, "No browser wallet found."));
}

function draw(): void {
  if (!root) return;
  const close = h("button.btn.btn-small", { type: "button", "aria-label": "Close the wallet" }, icon("cross"));
  close.addEventListener("click", () => setOpen(false));
  const logBox =
    state.busy || state.log.length || state.error
      ? h(
          "section.wallet-section",
          { "aria-live": "polite" },
          h("h3", state.busy ? `Working: ${state.busy}` : "Last action"),
          state.error ? h("div.note.bad", { id: "wallet-error" }, state.error) : null,
          h("ol.wallet-log", { id: "wallet-log" }, ...state.log.map((l) => h("li", l.text, l.tx ? " " : null, l.tx ? explorerLink(l.tx) : null))),
          explorerOn() && state.log.some((l) => l.tx) ? h("p.small.muted.tx-note", EXPLORER_NOTE) : null,
        )
      : null;
  root.replaceChildren(
    h("div.wallet-head", h("div", h("strong", "Wallet"), h("div.small.muted", cfg?.local ? "Local node. Nothing here touches a real network." : "Testnet only. A guest account is for trying the app, never for real funds.")), close),
    logBox ?? "",
    guestSection(),
    qorexSection(),
    metamaskSection(),
  );
  document.querySelectorAll(".wallet-btn").forEach(fillButton);
}
