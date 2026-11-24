/**
 * judge-live.ts - every attempt of the /judge page, from a terminal, against the
 * testnet. Exits 1 if any answer is not the intended one.
 *
 *   npm run judge:live
 *
 * No key, no account, no transaction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { attempts, JUDGE, reason, runStep, type JudgeContext } from "../client/judge.ts";

const PUBLIC = join(import.meta.dirname, "..", "apps", "web", "public");
const cfg = JSON.parse(readFileSync(join(PUBLIC, "config.testnet.json"), "utf8"));
const ep = { url: process.env.QORE_EVM_RPC_URL?.trim() || JUDGE.rpc };
const ctx: JudgeContext = {
  ep,
  client: createPublicClient({ transport: http(ep.url) }),
  rest: process.env.QORE_REST_URL?.trim() || JUDGE.rest,
  registry: cfg.registry,
  factory: cfg.factory,
  pealt: cfg.pealt,
  faucet: cfg.faucet,
  committeeSetId: cfg.committeeSetId,
  openAuction: cfg.demoAuction,
  cards: async () => JSON.parse(readFileSync(join(PUBLIC, "committee-cards.testnet.json"), "utf8")),
};

let bad = 0;
for (const a of attempts(ctx)) {
  console.log(`\n${a.title}`);
  try {
    for (const s of await a.steps()) {
      const r = await runStep(ctx, s);
      const ok = r.verdict.kind === "intended";
      if (!ok) bad++;
      console.log(`  ${ok ? "ok " : "BAD"} [${s.role}] ${s.label}: ${r.said}${ok ? "" : ` (${r.verdict.kind})`} ${r.ms} ms`);
    }
  } catch (err) {
    bad++;
    console.log(`  BAD could not prepare: ${reason(err)}`);
  }
}
console.log(bad ? `\n${bad} answers were not the intended ones` : "\nevery answer was the intended one");
process.exit(bad ? 1 : 0);
