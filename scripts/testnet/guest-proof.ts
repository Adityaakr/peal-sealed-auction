/**
 * guest-proof.ts - a visitor's whole path on the testnet, through the built pages
 * served as Vercel serves them (npm run web:preview), in headless Chromium:
 *
 *   landing page → wallet drawer → guest account claims 1,000 PEAL-T from the demo
 *   faucet (registering its ML-DSA-87 key and opening a scoped window first) →
 *   bid page: committee check, seal in the browser, approve + commitBid in one
 *   scoped window → results page shows the bid as the guest's, still sealed.
 *
 *   npm run web:build && npm run web:preview          (terminal 1)
 *   npx tsx scripts/testnet/guest-proof.ts [base]     (terminal 2; base defaults to http://localhost:4173)
 *
 * The guest is a throwaway testnet account whose phrase lives in
 * ~/.qore-peal-sealed-auction/visitor.env (mode 0600). It is put straight into the
 * page's storage, as the drawer's import would, and never printed. Fund it first
 * (about 1 QOR). Browser: PW_CHROMIUM or Playwright's installed headless shell.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = (process.argv[2] ?? "http://localhost:4173").replace(/\/$/, "");
const q = "?net=testnet";
const phrase = readFileSync(join(homedir(), ".qore-peal-sealed-auction", "visitor.env"), "utf8").match(/MNEMONIC="([^"]+)"/)?.[1];
if (!phrase) throw new Error("no MNEMONIC in ~/.qore-peal-sealed-auction/visitor.env");
const shots = process.env.SHOTS_DIR?.trim();

const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
const errors: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((m) => {
    if (!localStorage.getItem("peal-sealed-auction.guest.v1")) localStorage.setItem("peal-sealed-auction.guest.v1", m);
  }, phrase);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const drawer = async () => (await page.$$eval("#wallet-log li", (ls) => ls.map((l) => l.textContent ?? ""))).join("\n    ");

  await page.goto(`${base}/${q}`);
  await page.waitForFunction(() => /\d/.test(document.querySelector("#pf-demo")?.textContent ?? ""), null, { timeout: 60_000 });
  console.log(`landing: open demo auction ${await page.textContent("#pf-demo")} (${await page.textContent("#pf-demo-sub")})`);

  await page.click("#hero-try");
  await page.waitForSelector("#guest-qor", { timeout: 60_000 });
  console.log(`guest ${(await page.getAttribute(".wallet .hash", "title"))?.split(" ")[0]}: ${await page.textContent("#guest-qor")}`);
  await page.waitForFunction(() => document.querySelector("#guest-pealt")?.textContent !== "…", null, { timeout: 30_000 });
  if ((await page.textContent("#guest-pealt")) === "0") {
    await page.click("#guest-get-pealt");
    await page.waitForFunction(() => document.querySelector("#guest-pealt")?.textContent === "1,000" || document.querySelector("#wallet-error"), null, { timeout: 300_000 });
    const err = await page.$("#wallet-error");
    if (err) throw new Error(`faucet claim: ${await err.textContent()}\n    ${await drawer()}`);
    console.log(`faucet claim:\n    ${await drawer()}`);
  }

  await page.goto(`${base}/bidder.html${q}`);
  await page.waitForFunction(() => document.querySelector("#who")?.textContent?.startsWith("0x"), null, { timeout: 60_000 });
  await page.click("#check-committee");
  await page.waitForFunction(() => document.querySelectorAll("#committee .ok").length === 3 || document.querySelector("#log .line.bad"), null, { timeout: 120_000 });
  await page.fill("#qty", "10");
  await page.selectOption("#tick", "3");
  await page.click("#seal-commit");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#log .line")].some((l) => l.textContent?.includes("bid committed") || l.classList.contains("bad")),
    null,
    { timeout: 300_000 },
  );
  const bad = await page.$$eval("#log .line.bad", (ls) => ls.map((l) => l.textContent));
  if (bad.length) throw new Error(`bid page: ${bad.join(" | ")}\n    ${await drawer()}`);
  const rows = await page.$$eval("#sealed > div", (ds) => ds.map((d) => d.textContent ?? ""));
  const at = rows.indexOf("commit tx");
  console.log(`bid: 10 fUSD at most 1.25 PEAL-T each, sealed in the browser:\n    ${await drawer()}\n    commit tx ${rows[at + 1]}`);
  if (shots) await page.screenshot({ path: join(shots, "testnet-guest-bid.png"), fullPage: true });

  await page.goto(`${base}/results.html${q}`);
  await page.waitForFunction(() => document.querySelectorAll("#bids tr.mine").length > 0, null, { timeout: 120_000 });
  console.log(`results: ${await page.$$eval("#bids tr.mine", (r) => r.length)} sealed bid(s) shown as the guest's`);
  if (shots) await page.screenshot({ path: join(shots, "testnet-results.png"), fullPage: true });
  if (errors.length) console.log(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
