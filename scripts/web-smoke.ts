/**
 * web-smoke.ts - drive the web pages through one whole auction in headless
 * Chromium, against the local stack.
 *
 *   npm run web:smoke
 *
 * Proves the client-side requirement end to end: bids are sealed in the
 * browser (ML-KEM-1024 + X25519 envelopes), committee members open their
 * shares in the browser and sign their releases there with ML-DSA-87, and the
 * contract opens the bids and settles. Member 3 stays offline.
 *
 * First, in a fresh browser context, a visitor's path: the landing page renders
 * with live figures and no sideways scroll at phone width, then a guest account
 * is made in the wallet drawer, funded, takes PEAL-T from the demo faucet and
 * seals a bid into the open demo buyback, which the results page shows as theirs.
 *
 * Browser: PW_CHROMIUM (an executable path) or Playwright's installed
 * headless shell (`npx playwright-core install --only-shell chromium`).
 * Screenshots go to SHOTS_DIR when it is set.
 */
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { parseUnits } from "viem";
import { createServer } from "vite";
import { startStack, writeLocalWebConfig } from "./local/stack.ts";

const ROOT = join(import.meta.dirname, "..");
const shots = process.env.SHOTS_DIR?.trim();

const s = await startStack({ log: () => {} });
const vite = await createServer({ configFile: join(ROOT, "apps", "web", "vite.config.ts"), server: { port: 0 }, logLevel: "error" });
let failed = false;
try {
  const auction = await s.createAuction();
  for (const b of s.bidders) await s.mintFusd(b.address, parseUnits("1000", 6));
  await s.mintFusd(s.issuer.address, parseUnits("1000", 6)); // for a buyback (D2)
  const demo = await s.createAuction({ name: "Open demo", kind: "buyback", commitSeconds: 7n * 86_400n });
  writeLocalWebConfig(s, auction, demo);
  await vite.listen();
  const base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "");

  const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
  try {
    await visitor(browser, base);
    const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await drive(page, base, auction);
    if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
    console.log("web smoke run passed");
  } finally {
    await browser.close();
  }
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await vite.close();
  s.stop();
}
process.exit(failed ? 1 : 0);

/** The landing page and a visitor's guest account, in their own browser context. */
async function visitor(browser: Browser, base: string): Promise<void> {
  const errors: string[] = [];
  const shot = async (page: Page, name: string) => {
    if (shots) await page.screenshot({ path: join(shots, name), fullPage: true });
  };

  // Phone width: everything fits, nothing scrolls sideways.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true });
  const p = await phone.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}/`);
  await p.waitForFunction(() => /^\d+$/.test(document.querySelector("#pf-auctions")?.textContent ?? ""), null, { timeout: 60_000 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`landing page scrolls sideways by ${overflow}px at 390px`);
  await shot(p, "0-landing-390.png");
  await phone.close();
  console.log("  ok  landing page at 390px: live figures, no sideways scroll");

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${base}/`);
  const title = (await page.textContent("h1")) ?? "";
  if (!title.includes("two of three keys")) throw new Error(`unexpected headline: ${title}`);
  await page.waitForFunction(() => document.querySelector("#pf-auctions")?.textContent === "2", null, { timeout: 60_000 });
  await page.waitForFunction(() => (document.querySelector("#pf-demo")?.textContent ?? "").includes("d"), null, { timeout: 60_000 });
  // The vault shows the demo auction's 20 slots; the reveal shows the testnet run's clearing price.
  await page.waitForFunction(() => document.querySelectorAll("#vault-slots .sa-slot").length === 20, null, { timeout: 30_000 });
  await page.locator("#reveal").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("#reveal-price")?.textContent === "1.50", null, { timeout: 60_000 });
  await shot(page, "0-landing-1280.png");
  console.log("  ok  landing page: headline, live figures, the vault's slots, the reveal's clearing price");

  // The wallet drawer: make, fund and use a guest account.
  await page.click("#hero-try");
  await page.waitForSelector("body.wallet-open #guest-create");
  await page.click("#guest-create");
  await page.waitForSelector("#guest-qor", { timeout: 60_000 });
  await page.click("#guest-fund-local");
  await page.waitForFunction(() => (document.querySelector("#guest-qor")?.textContent ?? "").startsWith("10 "), null, { timeout: 60_000 });
  await page.click("#guest-get-pealt");
  await page.waitForFunction(() => document.querySelector("#guest-pealt")?.textContent === "1,000", null, { timeout: 120_000 });
  const guest = (await page.getAttribute(".wallet .hash", "title"))?.split(" ")[0] ?? "";
  console.log(`  ok  guest account ${guest} made in the browser, funded, 1,000 PEAL-T from the faucet`);

  // Bid in the open demo auction with it (the bid page picks the demo auction by default).
  await page.goto(`${base}/bidder.html`);
  await page.waitForSelector("#use-guest", { timeout: 60_000 });
  await page.click("#use-guest");
  await page.waitForFunction((g) => document.querySelector("#who")?.textContent === g, guest, { timeout: 30_000 });
  await page.click("#check-committee");
  await page.waitForFunction(() => document.querySelectorAll("#committee .ok").length === 3, null, { timeout: 60_000 });
  await page.fill("#qty", "10");
  await page.selectOption("#tick", "2");
  await page.click("#seal-commit");
  await page.waitForFunction(() => [...document.querySelectorAll("#log .line")].some((l) => l.textContent?.includes("bid committed") || l.classList.contains("bad")), null, { timeout: 120_000 });
  const bad = await page.$$eval("#log .line.bad, #wallet-error", (ls) => ls.map((l) => l.textContent));
  if (bad.length) throw new Error(`bid page reported: ${bad.join(" | ")}`);
  await shot(page, "0-guest-bid.png");
  await page.goto(`${base}/results.html`);
  await page.waitForSelector("#use-guest", { timeout: 60_000 });
  await page.click("#use-guest");
  await page.waitForFunction(() => document.querySelectorAll("#bids tr.mine").length === 1, null, { timeout: 60_000 });
  console.log("  ok  the guest sealed a bid into the demo buyback; the results page shows it as theirs, still sealed");
  await ctx.close();
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
}

async function drive(page: Page, base: string, auction: string): Promise<void> {
  const q = `?auction=${auction}`;
  const useAccount = async (i: number) => {
    await page.waitForSelector("#acct");
    await page.selectOption("#acct", { index: i });
    await page.click("#use-account");
    await page.waitForFunction(() => document.querySelector("#who")?.textContent?.startsWith("0x"), null, { timeout: 60_000 });
  };
  const waitLog = async (text: string, timeout = 120_000) => {
    try {
      await page.waitForFunction(
        (t) => [...document.querySelectorAll("#log .line")].some((l) => l.textContent?.includes(t)),
        text,
        { timeout },
      );
    } finally {
      const bad = await page.$$eval("#log .line.bad", (ls) => ls.map((l) => l.textContent));
      if (bad.length) throw new Error(`page reported: ${bad.join(" | ")}`);
    }
  };
  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, name), fullPage: true });
  };

  // Accounts in config order: alice, bob, carol, member 1..3, issuer.
  // The issuer opens a buyback (D2: fUSD for PEAL-T) from the page.
  await page.goto(`${base}/issuer.html`);
  await useAccount(6);
  await page.selectOption("#kind", "buyback");
  await page.fill("#supply", "50");
  await page.fill("#reserve", "0.5");
  await page.fill("#step", "0.25");
  await page.click("#create");
  await waitLog("buyback auction");
  console.log(`  ok  issuer opened a buyback auction from the page: ${(await page.textContent("#created div"))?.trim()}`);

  const bids: [number, string, string][] = [
    [0, "50", "2"],
    [1, "70", "1"],
    [2, "100", "0"],
  ];
  for (const [acct, qty, tick] of bids) {
    await page.goto(`${base}/bidder.html${q}`);
    await useAccount(acct);
    await page.click("#check-committee");
    await page.waitForFunction(() => document.querySelectorAll("#committee .ok").length === 3, null, { timeout: 60_000 });
    await page.fill("#qty", qty);
    await page.selectOption("#tick", tick);
    await page.click("#seal-commit");
    await waitLog("bid committed");
    console.log(`  ok  bidder ${acct + 1} sealed ${qty} @ tick ${tick} in the browser and committed`);
    if (acct === 0) await shot("1-bidder.png");
  }

  await page.goto(`${base}/results.html${q}`);
  await useAccount(6);
  await page.click("#warp");
  await waitLog("1 hour ahead");
  await page.click("#close");
  await waitLog("bidding closed");

  for (const m of [3, 4]) {
    await page.goto(`${base}/committee.html${q}`);
    await useAccount(m);
    await page.waitForFunction(() => document.querySelector("#member-status")?.textContent?.includes("may release"), null, { timeout: 60_000 });
    await page.click("#open-shares");
    await waitLog("shares");
    if (m === 3) await shot("2-committee.png");
    await page.click("#release");
    await waitLog("release accepted");
    console.log(`  ok  member ${m - 2} opened its shares and signed its release in the browser`);
  }

  await page.goto(`${base}/results.html${q}`);
  await useAccount(6);
  await page.click("#open-bids");
  await waitLog("bids opened");
  await page.click("#warp");
  await waitLog("1 hour ahead");
  await page.click("#finalize");
  await waitLog("finalized");
  await page.click("#claim-all");
  await waitLog("paid out", 180_000);
  await shot("3-results.png");
  const price = (await page.textContent("#price")) ?? "";
  const state = (await page.textContent("#state")) ?? "";
  if (state !== "Settled" || !price.startsWith("1.5 ")) throw new Error(`expected Settled at 1.5, got ${state} at ${price}`);
  console.log(`  ok  settled at ${price} with member 3 offline; every bid paid out`);
  await page.click("#audit");
  await waitLog("audit passed");
  const verified = await page.$$eval("#audit td .chip.ok", (cs) => cs.filter((c) => c.textContent?.includes("signature verified here")).length);
  if (verified !== 2) throw new Error(`expected 2 releases verified in the browser, got ${verified}`);
  console.log("  ok  the browser verified both ML-DSA-87 releases (@qorechain/pqc) and reopened every bid itself");
}
