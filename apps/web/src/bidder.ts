/**
 * Bidder page. Sealing runs entirely in this browser: the bid is encrypted under
 * a fresh key, the key is split 2-of-3, and each share is sealed with QoreSeal
 * (ML-KEM-1024 + X25519) to a committee member whose keys were first checked
 * against what the member signed on chain. A visitor's guest account then sends
 * approve and commitBid inside one window scoped to the token and the auction.
 */
import { encodeFunctionData, hexToBytes, parseAbi, parseUnits, type Address } from "viem";
import { pealTAbi, sealedAuctionAbi } from "../../../client/abi.ts";
import { bidContext, sealBid } from "../../../client/bid.ts";
import { readCommittee, resolveCommittee } from "../../../client/committee.ts";
import type { SealRecipient } from "@qorechain/qoreseal";
import {
  $,
  accountPicker,
  activityCard,
  auctionSummary,
  carry,
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
import { amount, duration, h, icon } from "./ui.ts";
import type { Call } from "./wallet/guest.ts";

const faucetAbi = parseAbi(["function claim(uint256 amount)", "function claimableBy(address who) view returns (uint256 amount, uint64 availableAt)"]);

try {
  await main();
} catch (e) {
  fail(e);
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  header("Place a sealed bid", cfg);
  const client = publicClientOf(cfg);
  const app = $("#app");
  if (!cfg.auction) {
    app.replaceChildren(pageHead("Bid", "Place a sealed bid"), h("div.note", "No auction selected. ", h("a", { href: `./auctions.html${carry(cfg)}` }, "Pick one from the auctions"), "."));
    return;
  }
  const auction = cfg.auction;
  const s = await auctionSummary(client, auction);
  const dec = async (t: Address) => Number(await client.readContract({ address: t, abi: pealTAbi, functionName: "decimals" }));
  const sym = async (t: Address) => client.readContract({ address: t, abi: pealTAbi, functionName: "symbol" });
  const [saleDec, quoteDec, saleSym, quoteSym, now] = await Promise.all([
    dec(s.cfg.saleToken),
    dec(s.cfg.quoteToken),
    sym(s.cfg.saleToken),
    sym(s.cfg.quoteToken),
    client.getBlock().then((b) => b.timestamp),
  ]);
  const top = s.cfg.reservePrice + BigInt(s.cfg.numTicks - 1) * s.cfg.tickSize;
  const open = s.state === "CommitOpen" && now < s.cfg.endTime;

  app.replaceChildren(
    pageHead(
      "Bid",
      "Place a sealed bid",
      `Your bid is encrypted in this browser and stays sealed until the committee releases after the close. You pay one clearing price, never more than your limit.`,
    ),
  );
  const tile = (label: string, value: string, sub?: string) => h("div.card.stat", h("div.label", label), h("div.value.value-sm", value), sub ? h("div.sub", sub) : null);
  app.append(
    h(
      "div.grid.grid-4.tiles",
      tile("Selling", `${fmt(s.cfg.totalSupply, saleDec)} ${saleSym}`, `paid in ${quoteSym}`),
      tile("Your limit", `${fmt(s.cfg.reservePrice, quoteDec)} to ${fmt(top, quoteDec)}`, `${quoteSym} per ${saleSym}, ${s.cfg.numTicks} steps`),
      tile("Bidding", open ? `closes in ${duration(s.cfg.endTime - now)}` : STATE_WORDS[s.state]!, `${s.bidCount} of ${s.cfg.maxBids} bids so far`),
      tile("Committee", `${s.threshold} of ${s.members.length}`, `bond ${fmt(s.cfg.bidBond, quoteDec)} ${quoteSym}, refunded unless junk`),
    ),
    h("div.small.muted.auction-line", "Auction ", el("span", { class: "mono" }, auction), " · ", h("a", { href: `./results.html${carry(cfg)}` }, "results")),
  );
  if (!open) app.append(h("div.note.warn", `This auction is not taking bids (${STATE_WORDS[s.state]}). `, h("a", { href: `./results.html${carry(cfg)}` }, "See its results"), "."));

  let actor: Actor | undefined;
  const balLine = el("div", { class: "small muted", id: "balance" });
  const showBalance = async () => {
    if (!actor) return;
    const bal = await client.readContract({ address: s.cfg.quoteToken, abi: pealTAbi, functionName: "balanceOf", args: [actor.address] });
    balLine.textContent = `This account holds ${fmt(bal, quoteDec)} ${quoteSym}.`;
  };
  accountPicker(
    cfg,
    app,
    (a) => {
      actor = a;
      void showBalance();
    },
    { guest: true, role: "the bidder" },
  );
  app.querySelector(".card.account")?.append(balLine);

  // Step 1: the committee check.
  let recipients: SealRecipient[] | undefined;
  const comm = el("div", { class: "card step-card" }, h("div.step-head", h("span.step-n", "1"), el("h2", {}, "Check the committee")));
  const commBtn = el("button", { id: "check-committee" }, "Check every member's keys") as HTMLButtonElement;
  const commOut = el("div", { id: "committee", class: "members" });
  comm.append(
    el(
      "p",
      { class: "muted small" },
      "For each member: the ML-DSA-87 key from the chain (pqcKeyStatus), the ML-KEM-1024 key from REST checked against the hash the member signed, and the QoreSeal card checked against both. A lying REST proxy cannot slip in its own key.",
    ),
    commBtn,
    commOut,
  );
  app.append(comm);
  commBtn.onclick = () =>
    guard(commBtn, async () => {
      const fallback = cfg.committeeCards ? await fetch(cfg.committeeCards).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined) : undefined;
      const c = await readCommittee(client, cfg.registry, s.cfg.committeeSetId, undefined, fallback);
      recipients = await resolveCommittee(c, { client, rest: cfg.rest });
      commOut.replaceChildren(
        ...c.members.map((m) =>
          el("div", { class: "ok member" }, icon("check"), el("span", {}, `Member ${m.index}`), el("span", { class: "mono" }, short(m.address, 6)), el("span", { class: "mono muted" }, `ML-KEM sha3 ${short(m.kemKeySha3, 6)}`)),
        ),
      );
      logLine(`committee ${short(c.setId, 6)}: all ${c.members.length} members verified`, "ok");
    });

  // Step 2: the bid.
  const form = el("div", { class: "card step-card" }, h("div.step-head", h("span.step-n", "2"), el("h2", {}, "Seal and commit")));
  const qty = el("input", { id: "qty", class: "input", type: "number", min: "0", step: "any", placeholder: `how many ${saleSym}` }) as HTMLInputElement;
  const tick = el("select", { id: "tick", class: "input" }) as HTMLSelectElement;
  for (let t = 0; t < s.cfg.numTicks; t++) {
    const p = s.cfg.reservePrice + BigInt(t) * s.cfg.tickSize;
    const inv = p === 0n ? "∞" : (Number(10n ** BigInt(quoteDec)) / Number(p)).toPrecision(4);
    tick.append(el("option", { value: String(t) }, `at most ${fmt(p, quoteDec)} ${quoteSym} per ${saleSym}  (at least ${inv} ${saleSym} per ${quoteSym})`));
  }
  const need = el("div", { class: "need small", id: "need" }, "Enter a quantity to see what is held in escrow.");
  const sealBtn = el("button", { id: "seal-commit" }, "Seal in this browser and commit") as HTMLButtonElement;
  const out = el("div", { id: "sealed", class: "kv sealed" });
  form.append(
    el(
      "div",
      { class: "form-grid" },
      el("label", { class: "field" }, el("span", {}, `Quantity (${saleSym})`), qty),
      el("label", { class: "field" }, el("span", {}, "Your price limit"), tick),
    ),
    need,
    el("div", { class: "row" }, sealBtn),
    out,
  );
  app.append(form, activityCard());

  const preview = async () => {
    try {
      const q = parseUnits(qty.value || "0", saleDec);
      if (q === 0n) return void (need.textContent = "Enter a quantity to see what is held in escrow.");
      const escrow = (await client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "escrowFor", args: [q, Number(tick.value)] })) as bigint;
      need.textContent = `Held until settlement: ${fmt(escrow, quoteDec)} ${quoteSym} escrow + ${fmt(s.cfg.bidBond, quoteDec)} ${quoteSym} bond. Whatever you do not pay comes back.`;
    } catch {
      need.textContent = "";
    }
  };
  qty.addEventListener("input", () => void preview());
  tick.addEventListener("change", () => void preview());

  sealBtn.onclick = () =>
    guard(sealBtn, async () => {
      if (!actor) throw new Error("choose an account first");
      if (!recipients) throw new Error("check the committee first");
      const quantity = parseUnits(qty.value || "0", saleDec);
      if (quantity === 0n) throw new Error("enter a quantity");
      const t = Number(tick.value);
      const ctx = await bidContext(client, auction, actor.address, quantity, t);
      const needed = ctx.escrow + ctx.bond;
      const bal = await client.readContract({ address: s.cfg.quoteToken, abi: pealTAbi, functionName: "balanceOf", args: [actor.address] });
      const calls: Call[] = [];
      if (bal < needed) {
        // A guest bidding with PEAL-T may claim the shortfall from the demo faucet in the same window.
        const canClaim =
          actor.kind === "guest" && cfg.faucet && s.cfg.quoteToken.toLowerCase() === cfg.pealt.toLowerCase()
            ? ((await client.readContract({ address: cfg.faucet, abi: faucetAbi, functionName: "claimableBy", args: [actor.address] })) as [bigint, bigint])[0]
            : 0n;
        if (bal + canClaim < needed) throw new Error(`needs ${fmt(needed, quoteDec)} ${quoteSym} (escrow + bond); this account holds ${fmt(bal, quoteDec)}`);
        calls.push({ to: cfg.faucet!, data: encodeFunctionData({ abi: faucetAbi, functionName: "claim", args: [canClaim] }), label: `Claim ${amount(canClaim, quoteDec)} ${quoteSym} from the demo faucet` });
        logLine(`not enough ${quoteSym}: the faucet claim joins the same window`, "info");
      }
      const t0 = performance.now();
      const c = sealBid({ chainId: BigInt(cfg.chainId), auction, bidder: actor.address, seq: ctx.seq, quantity, tick: t, recipients, threshold: s.threshold });
      const ms = Math.round(performance.now() - t0);
      out.replaceChildren();
      const show = (k: string, v: string) => out.append(el("div", {}, k), el("div", { class: "mono" }, v));
      show("ciphertext", c.ct);
      show("key hash", c.keyHash);
      c.shareHashes.forEach((x, i) => show(`share ${i + 1} hash`, x));
      c.envelopes.forEach((e, i) => show(`envelope → member ${i + 1}`, `${hexToBytes(e).length} bytes, ${short(e, 12)}`));
      show("sealed in", `${ms} ms, in this browser`);
      logLine(`sealed bid #${ctx.seq} in ${ms} ms; plaintext never left this tab`, "ok");
      calls.push(
        { to: s.cfg.quoteToken, data: encodeFunctionData({ abi: pealTAbi, functionName: "approve", args: [auction, needed] }), label: `Approve ${fmt(needed, quoteDec)} ${quoteSym} for the auction` },
        {
          to: auction,
          data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "commitBid", args: [c.seq, c.ct, c.keyHash, c.shareHashes, c.envelopes, ctx.escrow] }),
          label: "Commit the sealed bid",
        },
      );
      const hashes = await runCalls(cfg, actor, "Place a sealed bid", calls);
      const hash = hashes[hashes.length - 1]!;
      show("commit tx", hash);
      logLine(`bid committed: escrow ${fmt(ctx.escrow, quoteDec)} + bond ${fmt(ctx.bond, quoteDec)} ${quoteSym}, tx ${short(hash)}`, "ok");
      out.append(
        el("div", {}, "next"),
        el("div", {}, "After the close the committee releases and the contract opens every bid. ", el("a", { href: `./results.html${carry(cfg)}` }, "Watch the results"), "."),
      );
      await showBalance();
    });
}
