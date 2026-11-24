import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createPublicClient, encodeErrorResult, hexToBytes, http, size, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealedAuctionAbi } from "../client/abi.ts";
import { batchInitcode, callParams, curlFor, ethCall, showError, verdict, type Endpoint } from "../client/attempts.ts";
import { attempts, ERRORS, runStep, type JudgeContext } from "../client/judge.ts";

const to = "0x9A98Fc3b3B5078Bd22bAE5fb937395Ba1AE8c7B4" as Address;
const call = { to, data: "0xc19d93fb" as Hex, block: 10n };
/** An endpoint that answers each request with the next of `replies`. */
function node(...replies: (object | Error | { status: number; text: string })[]): Endpoint & { asked: number } {
  const ep = {
    url: "http://node",
    asked: 0,
    retries: 2,
    backoffMs: 1,
    timeoutMs: 1_000,
    fetch: (async () => {
      const r = replies[Math.min(ep.asked++, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      if ("text" in r) return new Response(r.text as string, { status: (r as { status: number }).status });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...r }));
    }) as typeof fetch,
  };
  return ep;
}
const revert = (data: Hex) => ({ error: { code: 3, message: "execution reverted", data } });
const badState = (n: number) => encodeErrorResult({ abi: sealedAuctionAbi, errorName: "BadState", args: [n] });
const bodies = { ok: { result: "0x" } };

describe("attempts: why a call was refused", () => {
  it("decodes the contract's own error and passes only the intended check", async () => {
    const o = await ethCall(node(revert(badState(2))), call, ERRORS);
    expect(o).toMatchObject({ kind: "refused", name: "BadState", args: [2] });
    expect(verdict(o, { refused: "BadState", args: [2] })).toEqual({ kind: "intended" });
    expect(verdict(o, { refused: "BadState" })).toEqual({ kind: "intended" });
    // Refused, but not by the check the attempt is about.
    expect(verdict(o, { refused: "BadState", args: [4] })).toEqual({ kind: "another-check", got: "BadState(2)" });
    expect(verdict(o, { refused: "ReleaseSignatureInvalid" })).toEqual({ kind: "another-check", got: "BadState(2)" });
    expect(verdict(o, { accepted: true })).toEqual({ kind: "wrongly-refused", got: "BadState(2)" });
  });

  it("never takes an unnamed revert, or a bare one, for the intended check", async () => {
    for (const data of ["0x", "0xdeadbeef"] as Hex[]) {
      const o = await ethCall(node(revert(data)), call, ERRORS);
      expect(o.kind).toBe("refused");
      expect(verdict(o, { refused: "ReleaseSignatureInvalid" }).kind).toBe("another-check");
    }
    expect(showError({ args: [], data: "0x" })).toBe("a revert without data");
  });

  it("an acceptance is never a refusal, and an objection to its answer fails a control", async () => {
    const o = await ethCall(node(bodies.ok), call, ERRORS);
    expect(verdict(o, { refused: "TooEarly" })).toEqual({ kind: "wrongly-accepted" });
    expect(verdict(o, { accepted: true })).toEqual({ kind: "intended" });
    expect(verdict(o, { accepted: true, check: () => "wrong" })).toEqual({ kind: "wrongly-refused", got: "wrong" });
  });

  it("a node without the block is 'not run', not a refusal", async () => {
    for (const message of ["header not found", "height 12 is not available, lowest height is 99", "missing trie node abc"]) {
      const ep = node({ error: { code: -32000, message } });
      const o = await ethCall(ep, call, ERRORS);
      expect(o).toMatchObject({ kind: "unavailable", why: "history" });
      expect(verdict(o, { refused: "ReleaseSignatureInvalid" }).kind).toBe("not-run");
      expect(ep.asked).toBe(1); // an answer: not retried
    }
  });

  it("an unreachable node is retried, then 'not run'; a busy one recovers", async () => {
    const down = node(new Error("connection refused"));
    expect(await ethCall(down, call, ERRORS)).toMatchObject({ kind: "unavailable", why: "network" });
    expect(down.asked).toBe(3);
    const busy = node({ status: 429, text: "slow down" }, { status: 503, text: "<html>" }, bodies.ok);
    expect(await ethCall(busy, call, ERRORS)).toEqual({ kind: "accepted", data: "0x" });
    expect(await ethCall(node({ error: { code: -32005, message: "rate limited" } }), call, ERRORS)).toMatchObject({ kind: "unavailable", why: "rpc" });
  });

  it("shows the request it sends", () => {
    expect(callParams(call)).toEqual([{ to, data: "0xc19d93fb" }, "0xa"]);
    expect(callParams({ data: "0x00" })).toEqual([{ data: "0x00" }, "latest"]);
    const body = JSON.parse(/-d '(.*)'$/.exec(curlFor("http://node", call))![1]!);
    expect(body).toMatchObject({ method: "eth_call", params: callParams(call) });
  });
});

describe("batchInitcode", () => {
  it("copies each call's data from where it lies, and jumps only to jump destinations", () => {
    const calls = [
      { to, data: "0x11223344" as Hex },
      { to, data: `0x${"ab".repeat(1752)}` as Hex },
      { to, data: "0x" as Hex },
    ];
    const code = hexToBytes(batchInitcode(calls));
    const total = calls.reduce((n, c) => n + size(c.data), 0);
    let at = 0;
    let offset = code.length - total;
    const be = (i: number) => (code[i]! << 16) | (code[i + 1]! << 8) | code[i + 2]!;
    for (const c of calls) {
      expect(code[at]).toBe(0x62); // PUSH3 length
      expect(be(at + 1)).toBe(size(c.data));
      expect(code[at + 4]).toBe(0x62); // PUSH3 offset
      expect(be(at + 5)).toBe(offset);
      at += 8 + 2 + 2 + 4 + 3 + 20 + 2; // codecopy, then the call
      expect(code[at]).toBe(0x62); // PUSH3 resume
      const resume = be(at + 1);
      expect(code[at + 4]).toBe(0x57);
      expect(code[resume]).toBe(0x5b);
      at = resume + 1;
      offset += size(c.data);
    }
    expect(Buffer.from(code.slice(at, at + 7)).toString("hex")).toBe("3d5f5f3e3d5ff3");
    expect(offset).toBe(code.length);
  });
});

describe("the judge page's attempts, on recorded testnet answers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("every answer comes from the intended check", async () => {
    const root = join(import.meta.dirname, "..");
    const recorded = JSON.parse(readFileSync(join(root, "test-ts", "fixtures", "judge-testnet.json"), "utf8"));
    const digest = (x: string) => createHash("sha256").update(x).digest("hex").slice(0, 20);
    const answer = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (u.pathname.startsWith("/rest/")) {
        const r = recorded[digest(`REST ${u.pathname}${u.search}`)];
        return new Response(r?.body ?? "{}", { status: r?.status ?? 503 });
      }
      const q = JSON.parse(String(init!.body)) as { id: number; method: string; params?: unknown[] };
      const [c, block] = (q.params ?? []) as [{ to?: string; data?: string } | undefined, unknown];
      const p = q.method === "eth_call" && c && !c.to && block === "latest" ? ["batch", c.data?.length, block] : (q.params ?? []);
      const a = recorded[digest(JSON.stringify([q.method, p]))];
      if (!a) throw new Error(`no recorded answer for ${q.method}: run npm run judge:smoke -- --record`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, ...a }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    vi.stubGlobal("fetch", answer);
    const pub = join(root, "apps", "web", "public");
    const cfg = JSON.parse(readFileSync(join(pub, "config.testnet.json"), "utf8"));
    const ctx: JudgeContext = {
      ep: { url: "http://node/" },
      client: createPublicClient({ transport: http("http://node/", { retryCount: 0 }) }),
      rest: "http://node/rest",
      registry: cfg.registry,
      factory: cfg.factory,
      pealt: cfg.pealt,
      faucet: cfg.faucet,
      committeeSetId: cfg.committeeSetId,
      openAuction: cfg.demoAuction,
      cards: async () => JSON.parse(readFileSync(join(pub, "committee-cards.testnet.json"), "utf8")),
    };
    const ids = new Set<string>();
    for (const a of attempts(ctx)) {
      for (const s of await a.steps()) {
        const r = await runStep(ctx, s);
        expect(r.verdict, `${a.id}/${s.id}: ${r.said}`).toEqual({ kind: "intended" });
        ids.add(s.id);
      }
    }
    expect(ids.size).toBe(28);
  });
});
