// capture.mjs - the real screens the film shows, at 2x, from the built site served as Vercel serves it.
//
//   (in the repository)  npm run web:build && npm run web:preview
//   (in the film folder) export REPO=/absolute/path/to/peal-sealed-auction
//                        FUND=deployer "$REPO/node_modules/.bin/tsx" src/capture.mjs [base]
//
// base defaults to http://localhost:4173 (or the hosted site). The app shots are a FRESH guest
// account made in the page, which places a real sealed bid in the open demo auction on the
// testnet. It needs about 1 test QOR: with FUND=deployer the repository's own testnet
// deployer sends 1.2 QOR (keys from ~/.qore-peal-sealed-auction, never printed); otherwise the
// script prints the guest's address and waits until it is funded from the dashboard faucet.
// ONLY=landing takes just the landing page's shots (no bid); ONLY=app skips them.
// Browser: PW_CHROMIUM, or Playwright's installed one.
import { join } from "node:path";

const REPO = process.env.REPO;
if (!REPO) throw new Error("set REPO to the peal-sealed-auction checkout");
const { chromium } = await import(join(REPO, "node_modules/playwright-core/index.mjs"));
const base = (process.argv[2] ?? "http://localhost:4173").replace(/\/$/, "");
// Served from this machine the pages prefer a local stack, so ask for the testnet explicitly.
const Q = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname) ? "?net=testnet" : "";
const SETTLED = "0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124";
const OUT = join(process.cwd(), "assets", "shots");
const shot = (el, name) => el.screenshot({ path: join(OUT, `${name}.png`) });
const wait = (p, ms) => p.waitForTimeout(ms);

const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "no-preference" });
const page = await ctx.newPage();
try {
  // The landing page: the hero, then each diagram section.
  await page.goto(`${base}/${Q}`);
  await page.waitForFunction(() => /\d/.test(document.querySelector("#pf-demo")?.textContent ?? ""), null, { timeout: 60_000 });
  await wait(page, 5000);
  await page.screenshot({ path: join(OUT, "hero.png") });
  if (process.env.ONLY === "app") { /* skip the sections */ } else {
  // The sticky nav would sit over each section; hide it for these shots only.
  const hideNav = await page.addStyleTag({ content: ".sa-nav { visibility: hidden !important; }" });
  for (const id of ["problem", "anatomy", "timeline", "keys", "reveal", "requirements", "try"]) {
    const s = page.locator(`#${id}`);
    await s.scrollIntoViewIfNeeded();
    await wait(page, id === "reveal" ? 3500 : 1200);
    await shot(s, id);
  }
  await hideNav.evaluate((n) => n.remove());
  }
  if (process.env.ONLY === "landing") process.exit(0);

  // A fresh guest from the hero's button.
  await page.evaluate(() => scrollTo(0, 0));
  await wait(page, 800);
  await page.click("#hero-try");
  await wait(page, 1200);
  await shot(page.locator(".wallet"), "drawer-create");
  await page.click("#guest-create");
  await page.waitForSelector("#guest-qor", { timeout: 60_000 });
  const qor1 = (await page.$$eval(".wallet .hash", (hs) => hs.map((h) => h.getAttribute("title") ?? ""))).join(" ").match(/qor1[0-9a-z]{38}/)?.[0];
  if (!qor1) throw new Error("no guest address in the drawer");
  if (process.env.FUND === "deployer") {
    const { load } = await import(join(REPO, "scripts/testnet/lib.ts"));
    const { broadcast } = await import(join(REPO, "node_modules/qore-pq-kit/scripts/index.ts"));
    const d = await load("deployer");
    const r = await broadcast(d.acc, [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: d.acc.cosmos, toAddress: qor1, amount: [{ denom: "uqor", amount: "1200000" }] } }]);
    console.log(`funded ${qor1} with 1.2 QOR: ${r.transactionHash}`);
  } else {
    console.log(`fund ${qor1} with about 1 QOR from https://dashboard.qorechain.io/faucet; waiting…`);
  }
  for (;;) {
    await page.getByRole("button", { name: "Check balance" }).click();
    await wait(page, 4000);
    if (!(await page.textContent("#guest-qor"))?.includes("needs QOR")) break;
  }
  await wait(page, 1500);
  await shot(page.locator(".wallet"), "drawer-funded");

  // The bid page: committee check, then seal and commit (the faucet claim joins the window).
  await page.goto(`${base}/bidder.html${Q}`);
  await page.waitForFunction(() => document.querySelector("#who")?.textContent?.startsWith("0x"), null, { timeout: 60_000 });
  await wait(page, 3000);
  await page.screenshot({ path: join(OUT, "bid-top.png") });
  await page.click("#check-committee");
  await page.waitForFunction(() => document.querySelectorAll("#committee .ok").length === 3, null, { timeout: 120_000 });
  await page.fill("#qty", "8");
  await page.selectOption("#tick", "3");
  await wait(page, 800);
  await page.locator("#committee").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, "bid-check.png") });
  await page.click("#seal-commit");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#log .line")].some((l) => l.textContent?.includes("bid committed") || l.classList.contains("bad")),
    null,
    { timeout: 400_000 },
  );
  if ((await page.$$("#log .line.bad")).length) throw new Error(await page.textContent("#log"));
  await wait(page, 1500);
  await shot(page.locator(".wallet"), "drawer-log");
  await page.getByRole("button", { name: "Close the wallet" }).click();
  await wait(page, 800);
  await page.screenshot({ path: join(OUT, "bid-sealed.png"), fullPage: true });

  await page.goto(`${base}/results.html${Q}`);
  await page.waitForFunction(() => document.querySelectorAll("#bids tr.mine").length > 0, null, { timeout: 120_000 });
  await wait(page, 2000);
  await page.screenshot({ path: join(OUT, "results-open.png") });

  // The settled testnet run, checked in the browser.
  await page.goto(`${base}/results.html${Q ? Q + "&" : "?"}auction=${SETTLED}`);
  await wait(page, 8000);
  await page.getByRole("button", { name: "Check it in this browser" }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("audit passed"), null, { timeout: 180_000 });
  await wait(page, 1500);
  await page.screenshot({ path: join(OUT, "settled.png"), fullPage: true });
  await page.goto(`${base}/committee.html${Q ? Q + "&" : "?"}auction=${SETTLED}`);
  await wait(page, 7000);
  await page.screenshot({ path: join(OUT, "committee.png") });
  console.log("shots written to", OUT);
} finally {
  await browser.close();
}
