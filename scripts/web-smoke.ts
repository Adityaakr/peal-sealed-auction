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
 * Browser: PW_CHROMIUM (an executable path) or Playwright's installed
 * headless shell (`npx playwright-core install --only-shell chromium`).
 * Screenshots go to SHOTS_DIR when it is set.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { parseUnits } from "viem";
import { createServer } from "vite";
import { LOCAL_WEB_CONFIG, localWebConfig, startStack } from "./local/stack.ts";

const ROOT = join(import.meta.dirname, "..");
const shots = process.env.SHOTS_DIR?.trim();

const s = await startStack({ log: () => {} });
const vite = await createServer({ configFile: join(ROOT, "apps", "web", "vite.config.ts"), server: { port: 0 }, logLevel: "error" });
let failed = false;
try {
  const auction = await s.createAuction();
  for (const b of s.bidders) await s.mintFusd(b.address, parseUnits("1000", 6));
  writeFileSync(LOCAL_WEB_CONFIG, JSON.stringify(localWebConfig(s, auction), null, 2));
  await vite.listen();
  const base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "");

  const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await drive(page, base);
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

async function drive(page: Page, base: string): Promise<void> {
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
  const bids: [number, string, string][] = [
    [0, "50", "2"],
    [1, "70", "1"],
    [2, "100", "0"],
  ];
  for (const [acct, qty, tick] of bids) {
    await page.goto(`${base}/bidder.html`);
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

  await page.goto(`${base}/results.html`);
  await useAccount(6);
  await page.click("#warp");
  await waitLog("1 hour ahead");
  await page.click("#close");
  await waitLog("bidding closed");

  for (const m of [3, 4]) {
    await page.goto(`${base}/committee.html`);
    await useAccount(m);
    await page.waitForFunction(() => document.querySelector("#member-status")?.textContent?.includes("may release"), null, { timeout: 60_000 });
    await page.click("#open-shares");
    await waitLog("shares");
    if (m === 3) await shot("2-committee.png");
    await page.click("#release");
    await waitLog("release accepted");
    console.log(`  ok  member ${m - 2} opened its shares and signed its release in the browser`);
  }

  await page.goto(`${base}/results.html`);
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
}
