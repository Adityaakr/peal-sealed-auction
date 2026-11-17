/**
 * amm-proof.ts - the bid page's "Buy fUSD on the AMM" on the testnet, through the
 * built pages served as Vercel serves them, in headless Chromium.
 *
 *   npm run web:build && npm run web:preview                  (terminal 1)
 *   npx tsx scripts/testnet/amm-proof.ts <fUSD sale auction> [base]   (terminal 2)
 *
 * The guest is the throwaway account of guest-proof.ts (~/.qore-peal-sealed-auction/
 * visitor.env, never printed). It needs about 2 QOR. The page quotes the buy from
 * the pool's reserves, then the guest signs one hybrid transaction: swap QOR for
 * fUSD with a floor of the amount, and convert it to the ERC-20 the auction pulls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const auction = process.argv[2];
if (!auction?.startsWith("0x")) throw new Error("usage: npx tsx scripts/testnet/amm-proof.ts 0x<fUSD sale auction> [base]");
const base = (process.argv[3] ?? "http://localhost:4173").replace(/\/$/, "");
const phrase = readFileSync(join(homedir(), ".qore-peal-sealed-auction", "visitor.env"), "utf8").match(/MNEMONIC="([^"]+)"/)?.[1];
if (!phrase) throw new Error("no MNEMONIC in ~/.qore-peal-sealed-auction/visitor.env");

const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
const errors: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((m) => {
    if (!localStorage.getItem("peal-sealed-auction.guest.v1")) localStorage.setItem("peal-sealed-auction.guest.v1", m);
  }, phrase);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/bidder.html?net=testnet&auction=${auction}`);
  await page.waitForFunction(() => document.querySelector("#who")?.textContent?.startsWith("0x"), null, { timeout: 60_000 });
  await page.waitForFunction(() => /QOR at most/.test(document.querySelector("#amm-quote")?.textContent ?? ""), null, { timeout: 60_000 });
  const first = await page.textContent("#amm-quote");
  await page.fill("#amm-amount", "0.1");
  await page.waitForFunction((t) => { const q = document.querySelector("#amm-quote")?.textContent ?? ""; return q !== t && /QOR at most/.test(q); }, first, { timeout: 30_000 });
  console.log(`quote: ${await page.textContent("#amm-quote")}`);
  console.log(`before: ${await page.textContent("#balance")}`);
  await page.click("#amm-buy");
  await page.waitForFunction(() => [...document.querySelectorAll("#log .line")].some((l) => /bought .* on the AMM|did not complete/.test(l.textContent ?? "")), null, { timeout: 300_000 });
  const lines = await page.$$eval("#log .line", (ls) => ls.map((l) => l.textContent ?? ""));
  const drawer = await page.$$eval("#wallet-log li", (ls) => ls.map((l) => l.textContent ?? ""));
  console.log(`page log:\n    ${lines.join("\n    ")}`);
  console.log(`wallet drawer:\n    ${drawer.join("\n    ")}`);
  await page.waitForTimeout(3000);
  console.log(`after: ${await page.textContent("#balance")}`);
  if (!lines.some((l) => /bought .* on the AMM/.test(l))) throw new Error("the AMM buy did not complete");
  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("AMM buy from the bid page passed");
} finally {
  await browser.close();
}
