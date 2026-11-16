/**
 * store.ts - who is connected, and running an action with the guest account.
 * Pages subscribe to changes; the wallet drawer and action buttons call in here.
 * Adapted from Peal Tender's apps/dashboard/src/wallet/store.ts.
 */
import type { UnifiedAccount } from "@qorechain/sdk";
import type { TransactionReceipt } from "viem";
import * as guest from "./guest.ts";
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
