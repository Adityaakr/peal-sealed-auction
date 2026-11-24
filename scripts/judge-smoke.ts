/**
 * judge-smoke.ts - drive the /judge page of the production build in headless Chromium,
 * served with Vercel's headers and rewrites, at desktop and phone widths.
 *
 *   npm run web:build && npm run judge:smoke              recorded testnet answers (CI)
 *   npm run web:build && npm run judge:smoke -- --live    the testnet itself
 *   npm run web:build && npm run judge:smoke -- --record  the testnet, and record its answers
 *
 * It checks that every attempt gets the intended answer, that the page never asks for
 * anything but reads, that nothing scrolls sideways, and that an unreachable node, a node
 * without history and a refusal by the wrong check each read as what they are and not as
 * a pass. The recording holds testnet answers only, so CI does not depend on a public node.
 *
 * Browser: PW_CHROMIUM (an executable path) or Playwright's installed headless shell.
 * Screenshots go to SHOTS_DIR when it is set.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page, type Route } from "playwright-core";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "test-ts", "fixtures", "judge-testnet.json");
const mode = process.argv.includes("--record") ? "record" : process.argv.includes("--live") ? "live" : "replay";
const shots = process.env.SHOTS_DIR?.trim();
const port = Number(process.env.PORT ?? 4179);
const base = `http://localhost:${port}`;
const RPC = "https://evm-testnet.qore.host";

/** The reads the page may make. Nothing that signs or sends. */
const READS = new Set(["eth_call", "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionByHash"]);

/** Every step, with what must be in its answer. Keep in step with client/judge.ts. */
const ANSWERS: Record<string, string> = {
  genuine: "accepted",
  "genuine-effect": "releaseCount is 1",
  "forged-valid": "valid under the outsider's key, invalid under member 1's",
  "forged-member": "ReleaseSignatureInvalid()",
  "forged-byte": "ReleaseSignatureInvalid()",
  "early-genuine": "BadState(CommitOpen)",
  "early-open": "BadState(CommitOpen)",
  "early-close": "TooEarly()",
  "replay-same": "AlreadyReleased(1)",
  "replay-slot": "ReleaseSignatureInvalid()",
  "replay-auction": "ReleaseSignatureInvalid()",
  "replay-today": "BadState(Settled)",
  "edit-share": "ReleaseSignatureInvalid()",
  "edit-drop": "ReleaseSignatureInvalid()",
  "edit-deadline": "ReleaseSignatureInvalid()",
  "one-of-three": "bid 0 is still sealed",
  "two-of-three": "bid 0 opened: 10 fUSD",
  "bid-right": "accepted: it would be bid",
  "bid-two": 'BadBid("share count")',
  "set-unknown": "UnknownSet(",
  "set-known": "ERC20InsufficientAllowance(",
  "join-swapped": "JoinSignatureInvalid(",
  "join-genuine": "accepted: set 0xd6da2884",
  "cards-swapped": "recipient card does not match",
  "bid-junk": "accepted: it would be bid",
  "now-genuine": "pqcVerify answers true",
  "now-byte": "pqcVerify answers false",
  "now-forged": "pqcVerify answers false",
};

type Rpc = { id: number; method: string; params?: unknown[] };
type Answer = { result?: unknown; error?: unknown };
/** The testnet's answers, as they are or tampered with by a test. */
type Network = { rpc?: (q: Rpc, real: () => Promise<Answer>) => Promise<Answer>; down?: boolean };

const recorded: Record<string, unknown> = mode === "replay" ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {};

function keyOf(method: string, params: unknown[]): string {
  let p: unknown = params;
  const [call, block] = params as [{ to?: string; data?: string } | undefined, unknown];
  // A bid is sealed afresh on every run, so its batched commit is known by its size.
  if (method === "eth_call" && call && !call.to && block === "latest") p = ["batch", call.data?.length, block];
  return createHash("sha256").update(JSON.stringify([method, p])).digest("hex").slice(0, 20);
}

async function ask(q: Rpc): Promise<Answer> {
  const key = keyOf(q.method, q.params ?? []);
  if (mode === "replay") {
    const a = recorded[key] as Answer | undefined;
    if (!a) throw new Error(`no recorded answer for ${q.method} ${JSON.stringify(q.params).slice(0, 160)}: run npm run judge:smoke -- --record`);
    return a;
  }
  const post = () => fetch(RPC, { signal: AbortSignal.timeout(15_000), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: q.id, method: q.method, params: q.params ?? [] }) });
  const res = await post().catch(post).catch(post);
  const body = (await res.json()) as Answer;
  const a: Answer = body.error ? { error: body.error } : { result: body.result };
  recorded[key] ??= a;
  return a;
}

async function open(browser: Browser, opts: BrowserContextOptions, net: Network): Promise<{ page: Page; problems: string[]; methods: Set<string> }> {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const problems: string[] = [];
  const methods = new Set<string>();
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  await page.route((u) => u.href.startsWith(RPC), async (route: Route) => {
    if (net.down) return route.abort("connectionrefused");
    const body = route.request().postDataJSON() as Rpc | Rpc[] | null;
    if (!body) return route.continue();
    if (mode === "live" && !net.rpc) {
      // The browser asks the testnet itself, exactly as a juror's does.
      for (const q of [body].flat()) methods.add(q.method);
      return route.continue();
    }
    try {
      const one = async (q: Rpc) => {
        methods.add(q.method);
        const a = await (net.rpc ? net.rpc(q, () => ask(q)) : ask(q));
        return { jsonrpc: "2.0", id: q.id, ...a };
      };
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(out) });
    } catch (err) {
      problems.push(String(err));
      await route.abort();
    }
  });
  await page.route((u) => u.href.startsWith(`${base}/rest/`), async (route: Route) => {
    const u = new URL(route.request().url());
    const key = createHash("sha256").update(`REST ${u.pathname}${u.search}`).digest("hex").slice(0, 20);
    if (mode === "replay") {
      const a = recorded[key] as { status: number; body: string } | undefined;
      return route.fulfill(a ? { status: a.status, contentType: "application/json", body: a.body } : { status: 503, contentType: "application/json", body: "{}" });
    }
    if (mode === "live") return route.continue();
    const res = await route.fetch().catch(() => undefined);
    if (!res) return route.abort();
    const body = await res.text();
    if (mode === "record") recorded[key] ??= { status: res.status(), body: slim(u.pathname, body) };
    await route.fulfill({ response: res, body });
  });
  // CI needs no fonts and no other host.
  if (mode === "replay") await page.route((u) => !u.href.startsWith(base) && !u.href.startsWith(RPC), (r) => r.abort());
  return { page, problems, methods };
}

/** The transaction search answers with whole transactions; the page reads only the hash. */
function slim(path: string, body: string): string {
  if (!path.endsWith("/cosmos/tx/v1beta1/txs")) return body;
  try {
    const j = JSON.parse(body) as { tx_responses?: { txhash: string }[] };
    return JSON.stringify({ tx_responses: (j.tx_responses ?? []).map((t) => ({ txhash: t.txhash })) });
  } catch {
    return body;
  }
}

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(what);
}

const PARTS = ["live", "settled-first", "settled-demo", "open-live", "committee-live"];
const states = (page: Page, want: string) =>
  page.waitForFunction(([ids, w]) => (ids as string[]).every((id) => document.getElementById(id)?.dataset.state === w), [PARTS, want] as const, { timeout: 90_000 });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const verdicts = (page: Page) =>
  page.$$eval("[data-step]", (els) => els.map((e) => ({ id: e.getAttribute("data-step")!, verdict: e.getAttribute("data-verdict")!, answer: e.querySelector(".jd-answer")?.textContent ?? "" })));
async function runAll(page: Page): Promise<void> {
  await page.click("#run-all");
  await page.waitForFunction(() => /Run them again/.test(document.querySelector("#run-all")?.textContent ?? ""), null, { timeout: 180_000 });
}

/** The whole page, as a juror would use it. */
async function juror(browser: Browser, name: string, opts: BrowserContextOptions): Promise<void> {
  const { page, problems, methods } = await open(browser, opts, {});
  await page.goto(`${base}/judge`);
  check(/Nothing to fund/.test((await page.textContent("h1")) ?? ""), `${name}: the headline is missing`);
  await page.waitForSelector("#run-all");
  if (shots) await page.screenshot({ path: join(shots, `judge-${name}-0-first-screen.png`) });
  for (const [what, selector] of [["run button", "#run-all"], ["guide", ".jd-steps"]] as const) {
    const bottom = await page.$eval(selector, (e) => Math.round(e.getBoundingClientRect().bottom - window.innerHeight));
    check(bottom <= 0, `${name}: the ${what} ends ${bottom}px below the first screen`);
  }
  await states(page, "ready");
  check((await overflow(page)) <= 0, `${name}: the page scrolls sideways by ${await overflow(page)}px`);
  // The settled auctions come before the attacks, and the open one after.
  const order = await page.$$eval("section[id]", (s) => s.map((x) => x.id));
  check(order.join() === "top,settled,attack,open,rubric,requirements", `${name}: sections in the order ${order.join()}`);

  await runAll(page);
  const got = await verdicts(page);
  for (const [id, answer] of Object.entries(ANSWERS)) {
    const r = got.find((x) => x.id === id);
    check(r, `${name}: step ${id} is missing`);
    check(r!.verdict === "intended" && r!.answer.includes(answer), `${name}: step ${id} got ${r!.verdict}: ${r!.answer}`);
  }
  check(got.length === Object.keys(ANSWERS).length, `${name}: ${got.length} steps, expected ${Object.keys(ANSWERS).length}`);
  const tally = (await page.textContent("#tally")) ?? "";
  check(/^19 of 19 attacks stopped/.test(tally) && tally.includes("8 of 8 controls work") && tally.includes("8 of 8 groups run"), `${name}: the tally says ${tally}`);

  for (const id of ["settled-first", "settled-demo"]) {
    await page.click(`#${id} .jd-audit-btn`);
    await page.waitForFunction((i) => /verified here|did not verify|partly|Could not/.test(document.querySelector(`#${i} .jd-audit .chip, #${i} .jd-audit .jd-fail`)?.textContent ?? ""), id, { timeout: 90_000 });
    const text = (await page.textContent(`#${id} .jd-audit`)) ?? "";
    check(text.startsWith("verified here"), `${name}: ${id} audit says ${text}`);
  }
  check((await overflow(page)) <= 0, `${name}: after the run the page scrolls sideways by ${await overflow(page)}px`);
  if (shots) {
    await page.screenshot({ path: join(shots, `judge-${name}-1-after.png`), fullPage: true });
    for (const id of order) await page.locator(`section#${id}`).screenshot({ path: join(shots, `judge-${name}-2-${id}.png`) });
  }

  const others = [...methods].filter((m) => !READS.has(m));
  check(!others.length, `${name}: the page asked for ${others.join()}`);
  check((await page.evaluate(() => localStorage.length)) === 0, `${name}: the page stored something`);
  check((await page.$$(".wallet-btn, input")).length === 0, `${name}: there is a wallet button or an input`);
  check(!problems.length, `${name}: ${problems.join(" | ")}`);
  await page.context().close();
  console.log(`  ok  ${name}: ${got.length} answers intended, both settled auctions re-verified, reads only (${[...methods].sort().join(", ")})`);
}

/** The landing page's first screen leads here, whatever the chain answers. */
async function landing(browser: Browser, name: string, opts: BrowserContextOptions): Promise<void> {
  const { page } = await open(browser, opts, { down: true });
  await page.goto(`${base}/`);
  await page.waitForSelector("#hero-judge");
  if (shots) await page.screenshot({ path: join(shots, `landing-${name}.png`) });
  const bottom = await page.$eval("#hero-judge", (e) => Math.round(e.getBoundingClientRect().bottom - window.innerHeight));
  check(bottom <= 0, `${name}: the landing page's jury link ends ${bottom}px below the first screen`);
  check((await overflow(page)) <= 0, `${name}: the landing page scrolls sideways`);
  await page.click("#hero-judge");
  await page.waitForSelector("#run-all");
  check(new URL(page.url()).pathname === "/judge", `${name}: the jury link leads to ${page.url()}`);
  await page.context().close();
  console.log(`  ok  landing ${name}: the jury link is in the first screen and leads to /judge`);
}

/** The node is down: every part says so and recovers by its own Retry. */
async function nodeDown(browser: Browser, opts: BrowserContextOptions): Promise<void> {
  const net: Network = { down: true };
  const { page } = await open(browser, opts, net);
  await page.goto(`${base}/judge`);
  await states(page, "failed");
  await runAll(page);
  const tally = (await page.textContent("#tally")) ?? "";
  check(/^0 of 0 attacks stopped/.test(tally) && /could not be prepared/.test(tally), `node down: the tally says ${tally}`);
  check(!(await page.$$(".jd-results .chip.ok")).length, "node down: something reads as refused");
  check((await overflow(page)) <= 0, "node down: the page scrolls sideways");
  if (shots) await page.screenshot({ path: join(shots, "judge-node-down.png"), fullPage: true });
  net.down = false;
  for (const id of PARTS) await page.click(`#${id} .jd-fail button`);
  await states(page, "ready");
  await page.click("#attempt-forged .jd-fail button");
  await page.waitForFunction(() => document.querySelector("#attempt-forged")?.getAttribute("data-state") === "done", null, { timeout: 60_000 });
  await page.context().close();
  console.log("  ok  node down: every part says so, nothing counts as refused, and each Retry recovers");
}

/** The node dropped the old blocks: those attempts could not run, and the rest still does. */
async function noHistory(browser: Browser, opts: BrowserContextOptions): Promise<void> {
  const old = (q: Rpc) => q.method === "eth_call" && q.params?.[1] !== "latest";
  const { page } = await open(browser, opts, { rpc: async (q, real) => (old(q) ? { error: { code: -32000, message: "header not found" } } : real()) });
  await page.goto(`${base}/judge`);
  await page.waitForSelector("#run-all");
  await runAll(page);
  const got = await verdicts(page);
  for (const id of ["genuine", "forged-member", "early-genuine", "replay-same", "edit-share", "one-of-three", "join-swapped"]) {
    check(got.find((x) => x.id === id)?.verdict === "not-run", `no history: ${id} is ${got.find((x) => x.id === id)?.verdict}`);
  }
  for (const id of ["early-open", "replay-today", "bid-two", "now-genuine", "now-byte", "now-forged"]) {
    check(got.find((x) => x.id === id)?.verdict === "intended", `no history: ${id} is ${got.find((x) => x.id === id)?.verdict}`);
  }
  await page.context().close();
  console.log("  ok  no history: attempts at old blocks say they could not run; the live ones still do");
}

/** A refusal by another check, and an acceptance, are never a pass. */
async function wrongAnswers(browser: Browser, opts: BrowserContextOptions): Promise<void> {
  let reply: Answer = {};
  // A release sent to an auction at an old block: about 10 kB of calldata, and nothing else is that size.
  const release = (q: Rpc) => {
    const call = q.params?.[0] as { to?: string; data?: string } | undefined;
    const size = call?.data?.length ?? 0;
    return q.method === "eth_call" && Boolean(call?.to) && size > 9_000 && size < 12_000 && q.params?.[1] !== "latest";
  };
  const { page } = await open(browser, opts, { rpc: async (q, real) => (release(q) ? reply : real()) });
  await page.goto(`${base}/judge`);
  await page.waitForSelector("#attempt-forged button");
  const run = async () => {
    await page.click("#attempt-forged .jd-attack-top button");
    await page.waitForFunction(() => document.querySelector("#attempt-forged")?.getAttribute("data-state") === "wrong", null, { timeout: 60_000 });
    return (await verdicts(page)).find((x) => x.id === "forged-member");
  };
  reply = { error: { code: 3, message: "execution reverted", data: "0xe7ec536e0000000000000000000000000000000000000000000000000000000000000004" } };
  const other = await run();
  check(other?.verdict === "another-check" && other.answer === "BadState(Settled)", `wrong check: ${JSON.stringify(other)}`);
  reply = { result: "0x" };
  const accepted = await run();
  check(accepted?.verdict === "wrongly-accepted", `accepted: ${JSON.stringify(accepted)}`);
  check(/^0 of 2 attacks stopped/.test((await page.textContent("#tally")) ?? ""), "wrong answers: the tally counts them");
  await page.context().close();
  console.log("  ok  wrong answers: another check's refusal and an acceptance both read as failures");
}

const server = spawn(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "web-preview.ts")], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
let failed = false;
try {
  await new Promise<void>((ok, no) => {
    server.stdout.once("data", () => ok());
    server.once("exit", (c) => no(new Error(`the preview server exited (${c})`)));
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
  try {
    const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };
    const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    await juror(browser, "1280", desktop);
    await juror(browser, "390", phone);
    await landing(browser, "1280", desktop);
    await landing(browser, "390", phone);
    await nodeDown(browser, phone);
    await noHistory(browser, desktop);
    await wrongAnswers(browser, desktop);
  } finally {
    await browser.close();
  }
  if (mode === "record") {
    writeFileSync(FIXTURE, `${JSON.stringify(recorded)}\n`);
    console.log(`recorded ${Object.keys(recorded).length} answers in ${FIXTURE}`);
  }
  console.log(`judge smoke run passed (${mode})`);
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
