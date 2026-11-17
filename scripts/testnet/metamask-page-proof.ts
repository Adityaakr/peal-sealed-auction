/**
 * metamask-page-proof.ts - "Seal, and sign in MetaMask" on the bid page, on the
 * testnet, through the built pages served as Vercel serves them, in headless
 * Chromium.
 *
 *   npm run web:build && npm run web:preview                       (terminal 1)
 *   npx tsx scripts/testnet/metamask-page-proof.ts [base]          (terminal 2)
 *
 * The guest is the throwaway account of guest-proof.ts (visitor.env). MetaMask is
 * stood in for by an EIP-6963 provider announced as io.metamask. It answers
 * eth_requestAccounts, chain switching and personal_sign, signing in this process
 * with a throwaway key (~/.qore-peal-sealed-auction/metamask-page-sim.env, never
 * printed). The page links that address to the guest under a spending rule for
 * the demo auction, has it sign approve and commitBid, and relays them from the
 * guest as MsgExecuteEVM.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { loadSecrets, writeSecrets } from "qore-pq-kit";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const base = (process.argv[2] ?? "http://localhost:4173").replace(/\/$/, "");
const dir = join(homedir(), ".qore-peal-sealed-auction");
const phrase = readFileSync(join(dir, "visitor.env"), "utf8").match(/MNEMONIC="([^"]+)"/)?.[1];
if (!phrase) throw new Error("no MNEMONIC in ~/.qore-peal-sealed-auction/visitor.env");
const simFile = join(dir, "metamask-page-sim.env");
if (!existsSync(simFile)) {
  const pk = generatePrivateKey();
  writeSecrets(simFile, { PRIVATE_KEY: pk, EVM_ADDRESS: privateKeyToAccount(pk).address }, "A throwaway key standing in for MetaMask in metamask-page-proof.ts. Testnet only. Never commit.");
}
const mm = privateKeyToAccount(loadSecrets(simFile).PRIVATE_KEY as Hex);

const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
const errors: string[] = [];
let prompts = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeFunction("__mmPersonalSign", async (data: Hex) => {
    prompts++;
    return mm.signMessage({ message: { raw: data } });
  });
  await ctx.addInitScript((m) => {
    if (!localStorage.getItem("peal-sealed-auction.guest.v1")) localStorage.setItem("peal-sealed-auction.guest.v1", m);
  }, phrase);
  // A separate script, given as text: localStorage throws in opaque-origin frames, and a
  // function compiled by tsx would carry helper calls the page does not have.
  await ctx.addInitScript({
    content: `(() => {
      const address = ${JSON.stringify(mm.address)};
      const provider = {
        isMetaMask: true,
        async request({ method, params }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
          if (method === "eth_chainId") return "0x2648";
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
          if (method === "personal_sign") return window.__mmPersonalSign(params[0]);
          throw new Error("stand-in MetaMask: " + method + " not supported");
        },
      };
      const detail = Object.freeze({ info: { uuid: "00000000-0000-4000-8000-000000000001", name: "MetaMask", icon: "data:,", rdns: "io.metamask" }, provider });
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    })();`,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  const drawer = async () => (await page.$$eval("#wallet-log li", (ls) => ls.map((l) => l.textContent ?? ""))).join("\n    ");

  await page.goto(`${base}/bidder.html?net=testnet`);
  await page.waitForFunction(() => document.querySelector("#who")?.textContent?.startsWith("0x"), null, { timeout: 60_000 });
  // Connect MetaMask in the wallet drawer.
  await page.click(".wallet-btn");
  await page.waitForSelector("text=Connect MetaMask", { timeout: 30_000 });
  await page.click("text=Connect MetaMask");
  await page.waitForSelector("text=QoreChain testnet", { timeout: 30_000 });
  console.log(`MetaMask (stand-in) ${mm.address} connected in the drawer`);
  await page.keyboard.press("Escape");

  await page.click("#check-committee");
  await page.waitForFunction(() => document.querySelectorAll("#committee .ok").length === 3 || document.querySelector("#log .line.bad"), null, { timeout: 120_000 });
  await page.fill("#qty", "1");
  await page.selectOption("#tick", "0");
  await page.click("#seal-commit-metamask");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#log .line")].some((l) => l.textContent?.includes("bid committed") || l.classList.contains("bad")),
    null,
    { timeout: 300_000 },
  );
  const bad = await page.$$eval("#log .line.bad", (ls) => ls.map((l) => l.textContent));
  if (bad.length) throw new Error(`bid page: ${bad.join(" | ")}\n    ${await drawer()}`);
  const rows = await page.$$eval("#sealed > div", (ds) => ds.map((d) => d.textContent ?? ""));
  console.log(`MetaMask was asked to sign ${prompts} time(s); wallet drawer:\n    ${await drawer()}\n    commit tx ${rows[rows.indexOf("commit tx") + 1]}`);
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("MetaMask bid from the bid page passed");
} finally {
  await browser.close();
}
