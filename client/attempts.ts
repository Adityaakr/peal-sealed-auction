/**
 * attempts.ts - try a call against a deployed contract and say why it was refused.
 *
 * A small module for a no-wallet judge or demo page. It sends real `eth_call`s (no
 * key, no account, no transaction), decodes the contract's own custom error, and
 * compares it with the one check the attempt was built to hit. It never turns a
 * failure to ask into a refusal: an unreachable node, or a node that no longer has
 * the block, is "not run", and a revert for any reason but the expected one is
 * "another check", not a pass.
 *
 * To reuse it on another site, copy this file. It needs only `viem`:
 *
 *   const r = await ethCall({ url }, { to, data, block: 10630881n }, abi);
 *   const v = verdict(r, { refused: "ReleaseSignatureInvalid" });
 *   // v.kind: "intended" | "another-check" | "wrongly-accepted" | "wrongly-refused" | "not-run"
 *
 * Three things worth knowing on QoreChain (testnet RPC, November 2026):
 * - `eth_call` at an old block works while the node keeps it, and the PQC precompiles
 *   answer there too. So an attempt can run in the exact state it needs, next to the
 *   genuine call that the chain accepted in that state.
 * - State overrides look usable but switch the precompiles off: `pqcKeyStatus` answers
 *   nothing under an override. Use an old block instead.
 * - A call to an address with no code succeeds with empty data. Check the contract's
 *   state at the same block before believing an acceptance (see `ethCall`'s data).
 */
import { concatHex, decodeErrorResult, numberToHex, pad, size, toHex, type Abi, type Address, type Hex } from "viem";

export interface Endpoint {
  url: string;
  fetch?: typeof globalThis.fetch;
  /** Per request; a slow node counts as unreachable. */
  timeoutMs?: number;
  /** Tries after the first when the node cannot be reached or is busy. Reverts are never retried. */
  retries?: number;
  /** Wait before the first retry; doubles each time. */
  backoffMs?: number;
}

export interface Call {
  /** Leave out to run `data` as creation code (see `batchInitcode`). */
  to?: Address;
  data: Hex;
  /** Anyone's address: `eth_call` needs no signature, so this is how a stolen classical key is modelled. */
  from?: Address;
  /** A block number, or the latest when left out. */
  block?: bigint;
}

export type Outcome =
  | { kind: "accepted"; data: Hex }
  /** `name` is the contract's custom error when the ABI has it. */
  | { kind: "refused"; name?: string; args: readonly unknown[]; data: Hex; message: string }
  /** The question was not answered. `history`: the node does not have that block's state. */
  | { kind: "unavailable"; why: "history" | "network" | "rpc"; message: string };

/** Thrown by `rpc` when the node answered with a JSON-RPC error. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** Thrown by `rpc` when the node could not be reached or did not answer JSON-RPC. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One JSON-RPC request. Retries what never reached the node; a JSON-RPC error is an answer. */
export async function rpc<T>(ep: Endpoint, method: string, params: unknown[]): Promise<T> {
  const tries = 1 + (ep.retries ?? 2);
  let last = "";
  for (let i = 0; i < tries; i++) {
    if (i) await sleep((ep.backoffMs ?? 700) * 2 ** (i - 1));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ep.timeoutMs ?? 15_000);
    try {
      const res = await (ep.fetch ?? globalThis.fetch)(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: abort.signal,
      });
      const body = (await res.json().catch(() => undefined)) as { result?: T; error?: { code?: number; message?: string; data?: unknown } } | undefined;
      if (body?.error) throw new RpcError(body.error.code ?? 0, body.error.message ?? "unnamed JSON-RPC error", body.error.data);
      if (!res.ok || body === undefined || !("result" in body)) throw new NetworkError(`HTTP ${res.status} without a JSON-RPC answer`);
      return body.result as T;
    } catch (err) {
      if (err instanceof RpcError) throw err;
      last = abort.signal.aborted ? `no answer in ${(ep.timeoutMs ?? 15_000) / 1000} s` : err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new NetworkError(last);
}

/** The JSON-RPC parameters of a call, as sent and as shown in `curlFor`. */
export function callParams(c: Call): [Record<string, string>, string] {
  return [{ ...(c.from ? { from: c.from } : {}), ...(c.to ? { to: c.to } : {}), data: c.data }, c.block === undefined ? "latest" : numberToHex(c.block)];
}

// What nodes say when they do not have a block's header or state.
const NO_HISTORY = /header not found|missing trie node|not available, lowest height|version (mismatch|does not exist)|failed to load state at height|block not found|pruned/i;

/** Run one call and sort the answer: accepted, refused by the contract, or not answered. */
export async function ethCall(ep: Endpoint, c: Call, abi: Abi): Promise<Outcome> {
  let data: Hex;
  try {
    data = await rpc<Hex>(ep, "eth_call", callParams(c));
  } catch (err) {
    if (!(err instanceof RpcError)) return { kind: "unavailable", why: "network", message: err instanceof Error ? err.message : String(err) };
    if (NO_HISTORY.test(err.message)) return { kind: "unavailable", why: "history", message: err.message };
    const revert = typeof err.data === "string" && /^0x([0-9a-f]{2})*$/i.test(err.data) ? (err.data as Hex) : undefined;
    // Only a revert is the contract's refusal; anything else is the node's trouble.
    if (revert === undefined && !/revert/i.test(err.message)) return { kind: "unavailable", why: "rpc", message: err.message };
    return { kind: "refused", ...decodeRevert(revert ?? "0x", abi), data: revert ?? "0x", message: err.message };
  }
  return { kind: "accepted", data };
}

/** The custom error in revert data, when the ABI knows it. `Error(string)` and `Panic` count. */
export function decodeRevert(data: Hex, abi: Abi): { name?: string; args: readonly unknown[] } {
  if (size(data) < 4) return { args: [] };
  try {
    const e = decodeErrorResult({ abi, data });
    return { name: e.errorName, args: (e.args ?? []) as readonly unknown[] };
  } catch {
    return { args: [] };
  }
}

export type Expect =
  /** The call must be accepted; `check` may look at the returned data and object. */
  | { accepted: true; check?: (data: Hex) => string | undefined }
  /** The contract must refuse with this error, and with these arguments when given. */
  | { refused: string; args?: readonly unknown[] };

export type Verdict =
  | { kind: "intended" }
  /** Refused, but by a different check than the attempt is about. */
  | { kind: "another-check"; got: string }
  | { kind: "wrongly-accepted" }
  | { kind: "wrongly-refused"; got: string }
  | { kind: "not-run"; why: string };

export function showError(o: { name?: string; args: readonly unknown[]; data: Hex }): string {
  if (!o.name) return o.data === "0x" ? "a revert without data" : `an unknown error ${o.data.slice(0, 10)}`;
  return `${o.name}(${o.args.map((a) => (typeof a === "string" && !a.startsWith("0x") ? JSON.stringify(a) : String(a))).join(", ")})`;
}

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Did the answer come from the check this attempt is about? */
export function verdict(o: Outcome, want: Expect): Verdict {
  if (o.kind === "unavailable") return { kind: "not-run", why: o.message };
  if ("refused" in want) {
    if (o.kind === "accepted") return { kind: "wrongly-accepted" };
    const argsOk = !want.args || (want.args.length === o.args.length && want.args.every((a, i) => same(a, o.args[i])));
    return o.name === want.refused && argsOk ? { kind: "intended" } : { kind: "another-check", got: showError(o) };
  }
  if (o.kind === "refused") return { kind: "wrongly-refused", got: showError(o) };
  const objection = want.check?.(o.data);
  return objection ? { kind: "wrongly-refused", got: objection } : { kind: "intended" };
}

/**
 * Creation code that makes `calls` in order from one fresh address and returns what the
 * last one returned; the first one that fails reverts the whole thing with its own data.
 * Sent as an `eth_call` without `to`, it plays a whole flow (claim, approve, commit) that
 * changes nothing on chain. The address the contracts see as `msg.sender` is
 * `getContractAddress({ from, nonce })`.
 */
export function batchInitcode(calls: readonly { to: Address; data: Hex }[]): Hex {
  const push3 = (n: number): Hex => concatHex(["0x62", pad(toHex(n), { size: 3 })]);
  const build = (codeSize: number): Hex => {
    let offset = codeSize;
    let code: Hex = "0x";
    for (const c of calls) {
      const n = size(c.data);
      code = concatHex([
        code,
        push3(n), push3(offset), "0x5f39", // codecopy(0, offset, n)
        "0x5f5f", push3(n), "0x5f5f73", c.to, "0x5af1", // call(gas, to, 0, 0, n, 0, 0)
      ]);
      const resume = size(code) + 4 + 1 + 7; // past PUSH3, JUMPI and the revert below
      code = concatHex([code, push3(resume), "0x57", "0x3d5f5f3e3d5ffd", "0x5b"]); // if (!ok) revert(returndata)
      offset += n;
    }
    return concatHex([code, "0x3d5f5f3e3d5ff3"]); // return(returndata)
  };
  return concatHex([build(size(build(0))), ...calls.map((c) => c.data)]);
}

/** The same request as a shell command, so anyone can repeat it without this page. */
export function curlFor(url: string, c: Call): string {
  return `curl -s ${url} -H 'content-type: application/json' -d '${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: callParams(c) })}'`;
}
