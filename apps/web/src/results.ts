/**
 * Results page: state, releases, bids as the contract opened them, the clearing
 * price, and the permissionless steps (close, open, finalize, claims) anyone can
 * call. Funds always go to the bidder or the issuer, whoever sends the call.
 */
import { createTestClient, encodeFunctionData, http, type Address, type Hex } from "viem";
import { pealTAbi, sealedAuctionAbi } from "../../../client/abi.ts";
import { auditAuction } from "../../../client/audit.ts";
import {
  $,
  accountPicker,
  activityCard,
  auctionSummary,
  carry,
  chainOf,
  el,
  fail,
  fmt,
  guard,
  header,
  loadConfig,
  logLine,
  pageHead,
  publicClientOf,
  runCalls,
  short,
  STATE_WORDS,
  type Actor,
} from "./common.ts";
import { explorerOn, EXPLORER_NOTE, txHash } from "./explorer.ts";
import { amount, chip, duration, h } from "./ui.ts";
import type { Call } from "./wallet/guest.ts";

const STATUS = ["sealed", "opened", "excluded", "unopenable"];
const EXCL = ["", "malformed", "below minimum", "over address cap", "escrow short", "no key", "no key after all releases"];

try {
  await main();
} catch (e) {
  fail(e);
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  header("Auction results", cfg);
  const client = publicClientOf(cfg);
  const app = $("#app");
  if (!cfg.auction) {
    app.replaceChildren(pageHead("Results", "Auction results"), h("div.note", "No auction selected. ", h("a", { href: `./auctions.html${carry(cfg)}` }, "Pick one from the auctions"), "."));
    return;
  }
  const auction = cfg.auction;
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: auction, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;

  const summaryCard = el("div", { id: "summary" });
  const bidsCard = el("div", { class: "card flush" }, el("div", { class: "card-pad" }, el("h2", {}, "Bids"), el("p", { class: "muted small" }, "Escrow is public: the bid page rounds it up to a shared bucket unless the bidder chooses the exact amount, and what is not spent is refunded.")), el("div", { class: "table-wrap", id: "bids" }));
  app.replaceChildren(
    pageHead("Results", "Auction results", "Every bid as the contract opened it, the clearing price, and the steps anyone may run. Funds always go to the bidder or the issuer."),
    summaryCard,
    bidsCard,
  );

  let actor: Actor | undefined;
  accountPicker(
    cfg,
    app,
    (a) => {
      actor = a;
      void render();
    },
    { guest: true, role: "anyone" },
  );
  const actions = el(
    "div",
    { class: "card" },
    el("h2", {}, "Permissionless steps"),
    el("p", { class: "muted small" }, "Anyone may run these, in this order. Releases come from the committee members themselves."),
  );
  const btn = (id: string, label: string, primary = false) => el("button", { id, class: primary ? "" : "secondary" }, label) as HTMLButtonElement;
  const bClose = btn("close", "Close bidding");
  const bOpen = btn("open-bids", "Open all bids");
  const bFinal = btn("finalize", "Finalize");
  const bMine = btn("claim-mine", "Claim my payout");
  const bClaim = btn("claim-all", "Pay out every bid and the issuer");
  const row = el("div", { class: "row" }, bClose, bOpen, bFinal, bMine, bClaim);
  if (cfg.network === "local") {
    const bWarp = btn("warp", "Local: skip 1 hour");
    row.append(bWarp);
    bWarp.onclick = () =>
      guard(bWarp, async () => {
        const t = createTestClient({ chain: chainOf(cfg), mode: "anvil", transport: http(cfg.evmRpc) });
        await t.increaseTime({ seconds: 3601 });
        await t.mine({ blocks: 1 });
        logLine("local chain moved 1 hour ahead", "info");
        await render();
      });
  }
  actions.append(row);

  // Check it yourself: the contract's verdicts, repeated in this browser from public data.
  const auditOut = el("div", { id: "audit" });
  const bAudit = btn("audit", "Check it in this browser");
  const auditCard = el(
    "div",
    { class: "card" },
    el("h2", {}, "Check it yourself"),
    el(
      "p",
      { class: "muted small" },
      "Your browser verifies each member's ML-DSA-87 release signature with @qorechain/pqc against the key the chain registered (pqcKeyStatus), then rebuilds every bid key from the stored shares and decrypts each bid itself. No trust in the contract's own checks, and nothing is sent.",
    ),
    el("div", { class: "row" }, bAudit),
    auditOut,
  );
  bAudit.onclick = () =>
    guard(bAudit, async () => {
      auditOut.replaceChildren(el("p", { class: "muted small" }, "Reading the releases and the stored shares…"));
      const [r, s] = await Promise.all([auditAuction(client, auction), auctionSummary(client, auction)]);
      const token = (t: Address, functionName: "decimals" | "symbol") => client.readContract({ address: t, abi: pealTAbi, functionName });
      const [sd, qd, ss, qs] = await Promise.all([
        token(s.cfg.saleToken, "decimals").then(Number),
        token(s.cfg.quoteToken, "decimals").then(Number),
        token(s.cfg.saleToken, "symbol"),
        token(s.cfg.quoteToken, "symbol"),
      ]);
      const inWords = (p: { quantity: bigint; tick: number }) => `${amount(p.quantity, sd, sd)} ${ss} at ≤ ${amount(s.cfg.reservePrice + BigInt(p.tick) * s.cfg.tickSize, qd, qd)} ${qs}`;
      const releaseRows = r.releases.map((x) =>
        el(
          "tr",
          {},
          el("td", {}, `member ${x.memberIndex}`),
          el("td", { class: "mono" }, short(x.member, 6)),
          el("td", {}, x.signatureOk === true ? chip("signature verified here", "ok") : x.signatureOk === false ? chip("signature does not verify", "bad") : chip(x.note ?? "not checked", "plain")),
          el("td", {}, x.txHash ? txHash(x.txHash, "release transaction") : ""),
        ),
      );
      const bidRows = r.bids.map((b) =>
        el(
          "tr",
          {},
          el("td", {}, `bid ${b.bidId}`),
          el("td", { class: "mono" }, b.reopened ? inWords(b.reopened) : "not reopened"),
          el("td", {}, b.agrees === true ? chip("agrees with the contract", "ok") : b.agrees === false ? chip("disagrees with the contract", "bad") : chip(b.note ?? "undecided", "wait")),
        ),
      );
      auditOut.replaceChildren(
        el("p", {}, r.ok ? chip("audit passed", "ok") : chip("audit did not pass", "bad")),
        el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, el("tr", {}, ...["Release", "Member", "ML-DSA-87", "Transaction"].map((x) => el("th", {}, x)))), el("tbody", {}, ...releaseRows))),
        el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, el("tr", {}, ...["Bid", "Reopened here", "Verdict"].map((x) => el("th", {}, x)))), el("tbody", {}, ...bidRows))),
        ...(explorerOn() ? [el("p", { class: "small muted" }, EXPLORER_NOTE)] : []),
      );
      logLine(r.ok ? "audit passed: releases verified and bids reopened in this browser" : "audit did not pass", r.ok ? "ok" : "bad");
    });
  app.append(actions, auditCard, activityCard());

  const sendAll = async (title: string, calls: Call[]): Promise<Hex[]> => {
    if (!actor) throw new Error("choose an account first");
    if (!calls.length) throw new Error("nothing to send");
    return runCalls(cfg, actor, title, calls);
  };
  const one = (label: string, functionName: string, args: unknown[] = []): Call => ({
    to: auction,
    data: encodeFunctionData({ abi: sealedAuctionAbi, functionName, args } as never),
    label,
  });
  const tx = (b: HTMLButtonElement, what: string, call: () => Promise<Call>) =>
    (b.onclick = () =>
      guard(b, async () => {
        const [h0] = await sendAll(what, [await call()]);
        logLine(`${what}: tx ${short(h0!)}`, "ok");
        await render();
      }));
  tx(bClose, "bidding closed", async () => one("Close bidding", "closeCommit"));
  tx(bOpen, "bids opened", async () => {
    const n = await read<number>("bidCount");
    return one("Open all bids", "openBids", [Array.from({ length: Number(n) }, (_, i) => BigInt(i))]);
  });
  tx(bFinal, "finalized", async () => one("Finalize", "finalize"));

  type B = { bidder: Address; ct: Hex; status: number; exclusion: number; quantity: bigint; tick: number; escrow: bigint; bondBurned: boolean; claimed: boolean };
  const unclaimed = async (mine: boolean): Promise<Call[]> => {
    const n = Number(await read<number>("bidCount"));
    const bids = await Promise.all(Array.from({ length: n }, (_, i) => read<B>("getBid", [BigInt(i)])));
    return bids.flatMap((b, i) => (!b.claimed && (!mine || b.bidder.toLowerCase() === actor?.address.toLowerCase()) ? [one(`Pay out bid ${i}`, "claim", [BigInt(i)])] : []));
  };
  bMine.onclick = () =>
    guard(bMine, async () => {
      const calls = await unclaimed(true);
      if (!calls.length) throw new Error("this account has no unpaid bids here");
      await sendAll("Claim my payout", calls);
      logLine(`paid out ${calls.length} of my bid${calls.length > 1 ? "s" : ""}`, "ok");
      await render();
    });
  bClaim.onclick = () =>
    guard(bClaim, async () => {
      const calls = await unclaimed(false);
      const state = Number(await read<number>("state"));
      if (state === 4 && !(await read<boolean>("proceedsClaimed"))) calls.push(one("Pay the issuer's proceeds", "claimProceeds"));
      if ((state === 4 || state === 5) && !(await read<boolean>("unsoldClaimed"))) calls.push(one("Return the unsold supply", "claimUnsold"));
      if (calls.length) await sendAll("Pay out everyone", calls);
      logLine("every bid and the issuer paid out", "ok");
      await render();
    });

  async function render(): Promise<void> {
    const [s, now] = await Promise.all([auctionSummary(client, auction), client.getBlock().then((b) => b.timestamp)]);
    const dec = async (t: Address) => Number(await client.readContract({ address: t, abi: pealTAbi, functionName: "decimals" }));
    const sym = (t: Address) => client.readContract({ address: t, abi: pealTAbi, functionName: "symbol" });
    const [sd, qd, ss, qs] = await Promise.all([dec(s.cfg.saleToken), dec(s.cfg.quoteToken), sym(s.cfg.saleToken), sym(s.cfg.quoteToken)]);
    const tile = (label: string, value: Node | string, sub?: Node | string, id?: string) =>
      h("div.card.stat", h("div.label", label), h("div.value.value-sm", id ? { id } : undefined, value), sub ? h("div.sub", sub) : null);
    const releases = h(
      "span.release-dots",
      ...s.members.map((_, i) => h(`i${(s.releaseMask >> i) & 1 ? ".on" : ""}`, { title: `member ${i + 1}: ${(s.releaseMask >> i) & 1 ? "released" : "not yet"}` })),
    );
    const released = s.members.filter((_, i) => (s.releaseMask >> i) & 1).length;
    let priceTile: HTMLElement;
    if (s.state === "Settled") {
      const [price, sold, proceeds] = await Promise.all([read<bigint>("clearingPrice"), read<bigint>("totalSold"), read<bigint>("grossProceeds")]);
      priceTile = tile("Clearing price", `${fmt(price, qd)} ${qs} per ${ss}`, `${fmt(sold, sd)} ${ss} sold for ${fmt(proceeds, qd)} ${qs}`, "price");
    } else {
      priceTile = tile("Clearing price", "not yet", s.state === "CommitOpen" ? `bidding ${now < s.cfg.endTime ? `closes in ${duration(s.cfg.endTime - now)}` : "has ended; anyone may close"}` : "after the bids are opened");
    }
    summaryCard.replaceChildren(
      h(
        "div.grid.grid-4.tiles",
        tile("State", el("span", { id: "state" }, s.state === "CommitOpen" && now >= s.cfg.endTime ? "Bidding has ended" : STATE_WORDS[s.state]!), el("span", {}, "in the contract: ", el("code", {}, s.state))),
        tile("Releases", h("span", { id: "releases" }, releases, ` ${released} of ${s.members.length}`), `${s.threshold} needed to open every bid`),
        tile("Bids", String(s.bidCount), `${fmt(s.cfg.totalSupply, sd)} ${ss} offered`),
        priceTile,
      ),
      h("div.small.muted.auction-line", "Auction ", el("span", { class: "mono" }, auction), " · ", h("a", { href: `./bidder.html${carry(cfg)}` }, "bid page")),
    );
    const ids = Array.from({ length: s.bidCount }, (_, i) => BigInt(i));
    const [bids, allocs] = await Promise.all([
      Promise.all(ids.map((i) => read<B>("getBid", [i]))),
      Promise.all(ids.map((i) => (s.state === "Settled" ? read<bigint>("allocationOf", [i]) : Promise.resolve(0n)))),
    ]);
    const rows = bids.map((b, i) => {
      const openedBid = b.status === 1 || b.status === 2;
      const mine = actor && b.bidder.toLowerCase() === actor.address.toLowerCase();
      const price = s.cfg.reservePrice + BigInt(b.tick) * s.cfg.tickSize;
      const statusChip = chip(STATUS[b.status]! + (b.exclusion ? `: ${EXCL[b.exclusion]}` : "") + (b.bondBurned ? ", bond burned" : ""), b.status === 1 ? "ok" : b.status >= 2 ? "bad" : "wait", b.status === 0 ? "lock" : undefined);
      return el(
        "tr",
        mine ? { class: "mine" } : {},
        el("td", {}, String(i)),
        el("td", { class: "mono" }, short(b.bidder, 6), ...(mine ? [" ", chip("you", "plain")] : [])),
        el("td", {}, statusChip),
        el("td", { class: "mono" }, openedBid ? `${fmt(b.quantity, sd)} ${ss} at ≤ ${fmt(price, qd)}` : `sealed ${short(b.ct, 6)}`),
        el("td", { class: "mono num" }, fmt(b.escrow, qd)),
        el("td", { class: "mono num" }, s.state === "Settled" ? fmt(allocs[i]!, sd) : "–"),
        el("td", {}, b.claimed ? "paid" : ""),
      );
    });
    $("#bids").replaceChildren(
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...["Bid", "Bidder", "Status", "Opened to", `Escrow (${qs})`, `Allocation (${ss})`, ""].map((x, i) => el("th", i === 4 || i === 5 ? { class: "num" } : {}, x)))),
        el("tbody", {}, ...(rows.length ? rows : [el("tr", {}, el("td", { colspan: "7", class: "empty" }, "No bids yet."))])),
      ),
    );
  }

  await render();
}
