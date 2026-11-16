/**
 * qorex.ts - QoreChain's own wallet, through `@qorechain/qorex-types`: the
 * official types and detection helpers for what QoreX injects
 * (`window.qorex = { evm, native, svm }`), so this page tracks QoreX's real
 * interface instead of a hand-written copy of it.
 *
 *   getQorexNative()          the native-lane provider, or undefined
 *   hasCapability(n, cap)     what this QoreX build declares it can do
 *   qorexSignAndBroadcast()   QoreX shows the messages, sets the fee, adds the
 *                             hybrid secp256k1 + ML-DSA-87 signature and broadcasts;
 *                             it answers with `shield`, its own re-read of whether
 *                             the committed transaction carries the ML-DSA-87 layer
 *   findQorexEip1193()        QoreX's EVM provider, found by EIP-6963 rdns
 *
 * What QoreX does not do for pages yet (qorex-types README, 0.1.0): sign or send
 * EVM transactions, open EVM windows, or sign arbitrary messages. So here QoreX
 * identifies the visitor and funds their guest account with one QOR transfer
 * they approve in QoreX; the guest account does the EVM actions.
 *
 * Started from Peal Tender's apps/dashboard/src/wallet/qorex.ts; rewritten on qorex-types.
 */
import {
  findQorexEip1193,
  getQorexNative,
  hasCapability,
  isQorexIntegrationError,
  QORECHAIN_TESTNET_CHAIN_ID,
  qorexSignAndBroadcast,
  type QorexShieldState,
} from "@qorechain/qorex-types";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";

const CHAIN_ID = QORECHAIN_TESTNET_CHAIN_ID;

export function available(): boolean {
  return getQorexNative() !== undefined;
}

export interface QorexAccount {
  cosmos: string;
  evm?: string;
}

export async function connect(): Promise<QorexAccount> {
  const native = getQorexNative();
  if (!native) throw new Error("QoreX is not installed in this browser.");
  try {
    await native.enable(CHAIN_ID);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unsupported chain|unrecognized chain/i.test(msg)) throw new Error("Switch QoreX to the QoreChain testnet (qorechain-diana), then connect again.");
    throw e;
  }
  const key = await native.getKey(CHAIN_ID);
  const cosmos = key.bech32Address;
  if (!cosmos) throw new Error("QoreX did not return an address.");
  let evm: string | undefined;
  try {
    const accounts = (await findQorexEip1193()?.request({ method: "eth_requestAccounts" })) as string[] | undefined;
    evm = accounts?.[0];
  } catch {
    // the EVM side is optional here
  }
  return { cosmos, evm };
}

export interface QorexSend {
  txHash: string;
  /** QoreX's own check of the committed transaction: "shielded" means it carries the ML-DSA-87 layer. */
  shield: QorexShieldState | string;
}

/** Send `uqor` test QOR from the QoreX account to `to` (a qor1 address); the user approves in QoreX. */
export async function sendQor(from: string, to: string, uqor: bigint): Promise<QorexSend> {
  const native = getQorexNative();
  if (!native) throw new Error("QoreX is not installed in this browser.");
  if (native.capabilities && !hasCapability(native, "signAndBroadcast")) {
    throw new Error("This QoreX build cannot send transactions for pages yet; update QoreX, or use the dashboard faucet.");
  }
  const value = MsgSend.encode(
    MsgSend.fromPartial({ fromAddress: from, toAddress: to, amount: [{ denom: "uqor", amount: uqor.toString() }] }),
  ).finish();
  let res;
  try {
    res = await qorexSignAndBroadcast(
      {
        chainId: CHAIN_ID,
        messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value }],
        memo: "Peal Sealed Auction: fund my guest account",
        gasLimit: 200_000,
      },
      { native },
    );
  } catch (e) {
    if (isQorexIntegrationError(e, "QOREX_NOT_SUPPORTED_YET")) throw new Error("This QoreX build predates signAndBroadcast; update QoreX.");
    throw e;
  }
  if (res.code !== 0) throw new Error(`QoreX transfer failed (code ${res.code}, tx ${res.txHash})`);
  if (res.shield === "downgraded") throw new Error(`QoreX committed tx ${res.txHash} WITHOUT the ML-DSA-87 layer; treat this account as at risk.`);
  return { txHash: res.txHash, shield: res.shield };
}
