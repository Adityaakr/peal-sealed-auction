/**
 * MetaMask bids on QoreChain, through `@qorechain/wallet-adapter`.
 *
 * MetaMask holds a classical secp256k1 key. It cannot make the ML-DSA-87
 * signature a native transaction needs, nor open the EVM window an EVM
 * transaction needs. QoreChain's route for such a key is an authenticator on a
 * post-quantum account:
 *
 *   1. Link (once, signed by the owner account with its hybrid key). MetaMask
 *      signs the chain's link message (EIP-191) as proof that it holds the key.
 *      The owner sends, in one transaction, a spending rule and
 *      `MsgRegisterAuthenticator` for the MetaMask address, with an expiry.
 *   2. Act. For each call MetaMask signs the chain's EVM-auth digest (EIP-191).
 *      The owner relays the signed `MsgExecuteEVM`, which runs the call as the
 *      owner's 0x address. The owner opens no window.
 *
 * The rule is what makes this safe after Q-Day. Whoever holds the MetaMask key
 * (a thief included) can only do what it lists:
 *   - with call data, only `claim` on the demo faucet, `approve` on the quote
 *     token, and `commitBid` and `claim` on this auction;
 *   - move only the quote token, at most `perBid` per call and `daily` per UTC
 *     day.
 * Anything else comes back `success = false`. The owner can revoke the key at
 * any time, and it lapses at `expiryUnix`.
 *
 * The owner here is the browser guest account (or a CLI account). The bid it
 * makes is the owner's bid; the committee recovers its envelopes from the
 * `MsgExecuteEVM` calldata (`client/release.ts`).
 */
import { fetchAuthNonce, type EncodeObject } from "@qorechain/sdk";
import {
  authenticatorExecutionResults,
  buildMetaMaskExecuteEvm,
  linkAuthenticatorMsgs,
  metaMaskPossessionProof,
  registerEthAuthenticatorMsg,
  resolveEvmAuthDigestVersion,
  revokeAuthenticatorMsg,
} from "@qorechain/wallet-adapter";
import { hexToBytes, toFunctionSelector, type Address, type Hex } from "viem";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export const SELECTORS = {
  approve: toFunctionSelector("approve(address,uint256)"),
  commitBid: toFunctionSelector("commitBid(uint32,bytes32,bytes32,bytes32[],bytes[],uint256)"),
  claim: toFunctionSelector("claim(uint256)"),
  faucetClaim: toFunctionSelector("claim(uint256)"),
} as const;

/** The spending rule's id on the owner's account; one auction at a time. */
export const RULE_ID = "peal-sealed-auction-metamask";

export interface BidRuleArgs {
  auction: Address;
  /** The auction's quote token: the only denom the key may move. */
  token: Address;
  /** The demo faucet, when the key may claim from it (brings value in, moves none out). */
  faucet?: Address;
  perBid: bigint;
  daily: bigint;
}

/** A spending rule (wallet-adapter/chain shape) that lets the linked key bid in one auction and nothing else. */
export function bidRule(a: BidRuleArgs) {
  if (a.perBid <= 0n || a.daily < a.perBid) throw new Error("perBid must be positive and at most the daily limit");
  const denom = `erc20/${a.token}`;
  const call = (target: Address, selector: Hex) => `${target.toLowerCase()}/${selector.toLowerCase()}`;
  return {
    id: RULE_ID,
    enabled: true,
    // Rule-level limits stay zero: the token's own limits are the only ones, and it is the only denom.
    perTxLimit: "0",
    dailyLimit: "0",
    allowedDenoms: [denom],
    denomLimits: [{ denom, perTxLimit: a.perBid.toString(), dailyLimit: a.daily.toString() }],
    allowedEvmCalls: [
      ...(a.faucet ? [call(a.faucet, SELECTORS.faucetClaim)] : []),
      call(a.token, SELECTORS.approve),
      call(a.auction, SELECTORS.commitBid),
      call(a.auction, SELECTORS.claim),
    ],
  };
}

export type BidRule = ReturnType<typeof bidRule>;

/**
 * The owner's messages that link `address` (MetaMask) under `rule`, for ONE
 * transaction the owner signs. MetaMask is asked once, for the possession proof.
 * They replace every spending rule on the owner's account.
 */
export async function linkMetaMaskMsgs(a: {
  provider: Eip1193;
  address: Address;
  owner: string;
  chainId: string;
  rule: BidRule;
  expiryUnix: bigint;
}): Promise<EncodeObject[]> {
  const possessionProof = await metaMaskPossessionProof({ provider: a.provider, address: a.address, chainId: a.chainId, account: a.owner });
  const registerMsg = registerEthAuthenticatorMsg({
    owner: a.owner,
    ethAddress: a.address,
    permissions: ["evm"],
    expiryUnix: Number(a.expiryUnix),
    label: "metamask",
    possessionProof,
  });
  return linkAuthenticatorMsgs({ registerMsg, rules: [a.rule] }) as EncodeObject[];
}

/** The owner's message that disables the MetaMask key at once. */
export function revokeMetaMaskMsg(owner: string, address: Address): EncodeObject {
  return revokeAuthenticatorMsg({ owner, scheme: "secp256k1", pubkey: hexToBytes(address) }) as EncodeObject;
}

export interface CallSpec {
  to: Address;
  data: Hex;
  gasLimit: bigint;
}

/**
 * Have MetaMask sign each call, in order, as `MsgExecuteEVM` for the owner's
 * account (one EIP-191 prompt per call). The key's nonce and the digest version
 * come from the chain, never guessed. `relayer` broadcasts them (hybrid) and pays.
 */
export async function metaMaskCalls(a: {
  provider: Eip1193;
  address: Address;
  owner: string;
  relayer: string;
  chainId: string;
  rest: string;
  calls: readonly CallSpec[];
}): Promise<EncodeObject[]> {
  const [{ nonce, linked }, digestVersion] = await Promise.all([
    fetchAuthNonce({ rest: a.rest, address: a.owner, pubkey: hexToBytes(a.address) }),
    resolveEvmAuthDigestVersion({ rest: a.rest }),
  ]);
  if (!linked) throw new Error(`${a.address} is not linked to ${a.owner} (or was revoked)`);
  const out: EncodeObject[] = [];
  for (let i = 0; i < a.calls.length; i++) {
    const c = a.calls[i]!;
    out.push(
      (await buildMetaMaskExecuteEvm({
        provider: a.provider,
        address: a.address,
        relayer: a.relayer,
        chainId: a.chainId,
        account: a.owner,
        to: c.to,
        value: "0",
        data: hexToBytes(c.data),
        gasLimit: Number(c.gasLimit),
        nonce: nonce + BigInt(i),
        digestVersion,
      })) as EncodeObject,
    );
  }
  return out;
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
}

/** Each `MsgExecuteEVM`'s own outcome in a code-0 transaction (a refused call is `success: false`, nonce spent). */
export function executionResults(result: Parameters<typeof authenticatorExecutionResults>[0]): ExecutionResult[] {
  return (authenticatorExecutionResults(result) as { success: boolean; reason?: string; vmError?: string }[]).map((r) => {
    const why = r.reason || r.vmError;
    return { success: r.success, ...(why ? { error: why } : {}) };
  });
}

/** The owner's current rules and authenticators, from REST (for display and checks). */
export async function readLink(rest: string, owner: string, f: typeof globalThis.fetch = globalThis.fetch) {
  const get = async (path: string) => {
    const r = await f(`${rest.replace(/\/+$/, "")}${path}`);
    return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  };
  const [rules, auths] = await Promise.all([
    get(`/qorechain/abstractaccount/v1/accounts/${owner}/spending_rules`),
    get(`/qorechain/abstractaccount/v1/accounts/${owner}/authenticators`),
  ]);
  return { rules, authenticators: auths };
}
