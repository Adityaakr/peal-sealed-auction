/**
 * explorer.ts - links to a transaction on QoreChain Explorer.
 *
 * The explorer finds a transaction by its native (CometBFT) hash only; an EVM
 * hash answers "Transaction not found". So for an EVM transaction the native
 * hash is looked up over REST first, and the link appears when it is known.
 * The explorer itself opens on mainnet until *Testnet* is pressed once.
 */
import { bech32 } from "@scure/base";
import { hexToBytes, type Address } from "viem";
import { h, hash, icon } from "./ui.ts";

const EXPLORER = "https://explore.qore.network/tx/";
const EXPLORER_ADDRESS = "https://explore.qore.network/address/";
/** What to tell people beside these links. */
export const EXPLORER_NOTE = "The explorer opens on mainnet: press Testnet in its top bar once.";

let rest: string | undefined;
/** Set once per page; left unset on the local node, where there is nothing to link to. */
export function configureExplorer(restUrl: string | undefined): void {
  rest = restUrl;
}

export function explorerOn(): boolean {
  return rest !== undefined;
}

const known = new Map<string, string>();
const looking = new Map<string, Promise<string | undefined>>();

/** The native hash of an EVM transaction, once the chain has indexed it. */
function nativeHash(evmHash: string): Promise<string | undefined> {
  const key = evmHash.toLowerCase();
  let p = looking.get(key);
  if (!p) {
    p = (async () => {
      const query = encodeURIComponent(`ethereum_tx.ethereumTxHash='${key}'`);
      for (const wait of [0, 2_000, 5_000, 10_000]) {
        await new Promise((r) => setTimeout(r, wait));
        const found = await fetch(`${rest}/cosmos/tx/v1beta1/txs?query=${query}&pagination.limit=1`)
          .then(async (r) => (r.ok ? ((await r.json()) as { tx_responses?: { txhash?: string }[] }).tx_responses?.[0]?.txhash : undefined))
          .catch(() => undefined);
        if (found && /^[0-9A-Fa-f]{64}$/.test(found)) {
          known.set(key, found);
          return found;
        }
      }
      looking.delete(key); // let a later render try again
      return undefined;
    })();
    looking.set(key, p);
  }
  return p;
}

/** A small "explorer" link for a transaction (nothing on the local node, or until its native hash is known). */
export function explorerLink(tx: string): HTMLElement {
  const slot = h("span.tx-link");
  if (!rest) return slot;
  const show = (native: string) =>
    slot.replaceChildren(h("a", { href: EXPLORER + native, target: "_blank", rel: "noopener", title: EXPLORER_NOTE, "aria-label": "open in QoreChain Explorer" }, "explorer", icon("out")));
  const native = tx.startsWith("0x") ? known.get(tx.toLowerCase()) : tx;
  if (native) show(native);
  else void nativeHash(tx).then((n) => n && show(n));
  return slot;
}

/** A copyable transaction hash followed by its explorer link. */
export function txHash(tx: string, label: string): HTMLElement {
  return h("span.tx", hash(tx, { label }), " ", explorerLink(tx));
}

/** An account or contract on the explorer, which knows addresses by their native (qor1) form. */
export function addressLink(a: Address, label: string): HTMLElement {
  const qor = bech32.encode("qor", bech32.toWords(hexToBytes(a)));
  return h("span.tx", hash(a, { label }), " ", h("a", { href: EXPLORER_ADDRESS + qor, target: "_blank", rel: "noopener", title: EXPLORER_NOTE, "aria-label": `${label} in QoreChain Explorer` }, "explorer", icon("out")));
}
