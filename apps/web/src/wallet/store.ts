/**
 * store.ts - who is connected, and running an action with the guest account.
 * Pages subscribe to changes; the wallet drawer and action buttons call in here.
 * Adapted from Peal Tender's apps/dashboard/src/wallet/store.ts.
 */
import type { UnifiedAccount } from "@qorechain/sdk";
import type { TransactionReceipt } from "viem";
import * as guest from "./guest.ts";
import * as metamask from "./metamask.ts";
import type { QorexAccount } from "./qorex.ts";

export interface WalletState {
  guest?: UnifiedAccount;
  guestStatus?: guest.GuestStatus;
  qorex?: QorexAccount;
  metamask?: { address: string; wallet: string; onQoreChain: boolean };
  busy?: string;
  log: string[];
  error?: string;
  /** Set once the saved guest (if any) has been read. */
  ready: boolean;
}

export const state: WalletState = { log: [], ready: false };
const listeners = new Set<() => void>();

export function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function emit(): void {
  for (const f of listeners) f();
}

export function log(line: string): void {
  state.log = [...state.log.slice(-30), line];
  emit();
}

export async function refreshGuest(): Promise<void> {
  try {
    state.guest = await guest.account();
    state.guestStatus = state.guest ? await guest.status(state.guest) : undefined;
  } catch (e) {
    state.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
  state.ready = true;
  emit();
}

/** Open the wallet drawer (set by the drawer module). */
let opener: () => void = () => {};
export function openPanel(): void {
  opener();
}
export function setOpenPanel(f: () => void): void {
  opener = f;
}

/**
 * Run EVM calls as the guest account, logging each step in the drawer. Opens the
 * drawer when there is no guest yet. Returns the receipts, or undefined on failure
 * (the error is in `state.error` and shown in the drawer).
 */
export async function act(title: string, calls: guest.Call[], after?: () => void): Promise<TransactionReceipt[] | undefined> {
  if (!state.guest) {
    state.error = "Create a guest account (or import one) to do this.";
    openPanel();
    emit();
    return undefined;
  }
  if (state.busy) return undefined;
  state.busy = title;
  state.error = undefined;
  state.log = [];
  emit();
  openPanel();
  try {
    const out = await guest.run(state.guest, calls, log);
    log(`${title}: done.`);
    after?.();
    return out;
  } catch (e) {
    state.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return undefined;
  } finally {
    state.busy = undefined;
    await refreshGuest();
  }
}

/**
 * Buy `want` of a fest token (the ERC-20 `erc20`) on the AMM with the guest's QOR,
 * converted to the ERC-20 in the same transaction. Same drawer logging as `act`.
 */
export async function buyOnAmm(title: string, erc20: `0x${string}`, want: bigint): Promise<string | undefined> {
  if (!state.guest) {
    state.error = "Create a guest account (or import one) to do this.";
    openPanel();
    emit();
    return undefined;
  }
  if (state.busy) return undefined;
  state.busy = title;
  state.error = undefined;
  state.log = [];
  emit();
  openPanel();
  try {
    const { tx } = await guest.buyOnAmm(state.guest, erc20, want, log);
    log(`${title}: done.`);
    return tx;
  } catch (e) {
    state.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return undefined;
  } finally {
    state.busy = undefined;
    await refreshGuest();
  }
}

/**
 * Run `calls` signed in MetaMask, relayed by the guest account under a spending
 * rule for this auction (`guest.runWithMetaMask`). Same drawer logging as `act`.
 */
export async function actWithMetaMask(
  title: string,
  scope: { auction: `0x${string}`; token: `0x${string}`; faucet?: `0x${string}`; perBid: bigint; daily: bigint },
  calls: guest.Call[],
): Promise<string | undefined> {
  const provider = metamask.provider();
  if (!state.guest || !state.metamask || !provider) {
    state.error = "Connect MetaMask and keep a guest account: the guest is the post-quantum account MetaMask acts for.";
    openPanel();
    emit();
    return undefined;
  }
  if (state.busy) return undefined;
  state.busy = title;
  state.error = undefined;
  state.log = [];
  emit();
  openPanel();
  try {
    const tx = await guest.runWithMetaMask(state.guest, { provider, address: state.metamask.address as `0x${string}` }, scope, calls, log);
    log(`${title}: done (tx ${tx.slice(0, 10)}…).`);
    return tx;
  } catch (e) {
    state.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return undefined;
  } finally {
    state.busy = undefined;
    await refreshGuest();
  }
}
