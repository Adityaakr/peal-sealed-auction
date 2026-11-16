/**
 * Committee member page. The member's keys are derived in this browser, its
 * envelopes are opened here (client-side decryption), and its release is
 * signed here with ML-DSA-87. A share is one random field element: alone it
 * says nothing about any bid.
 */
import { encodeFunctionData, type Hex } from "viem";
import { sealedAuctionAbi } from "../../../client/abi.ts";
import { openMemberShares, readBids, releaseMessage, signRelease, type ReleaseShares } from "../../../client/release.ts";
import { $, accountPicker, auctionSummary, el, guard, header, loadConfig, logLine, publicClientOf, send, short, type DevAccount } from "./common.ts";

const cfg = await loadConfig();
header("Committee member", cfg);
const client = publicClientOf(cfg);
const app = $("#app");
if (!cfg.auction) {
  app.replaceChildren(el("div", { class: "card" }, "No auction selected: open one from the home page."));
  throw new Error("no auction");
}
const auction = cfg.auction;
app.replaceChildren(el("div", { class: "card" }, el("h1", {}, "Committee member"), el("div", { class: "mono" }, auction)));

let me: DevAccount | undefined;
let index = 0;
let opened: ReleaseShares | undefined;
const status = el("div", { id: "member-status", class: "muted" }, "Choose the member account.");
accountPicker(cfg, app, (d) => {
  me = d;
  void refresh();
});

const work = el("div", { class: "card" }, el("h2", {}, "My shares"), status);
const openBtn = el("button", { id: "open-shares" }, "Open my shares in this browser") as HTMLButtonElement;
const relBtn = el("button", { id: "release" }, "Sign and submit my release (ML-DSA-87)") as HTMLButtonElement;
const table = el("div", { class: "tablewrap", id: "shares" });
work.append(el("div", { class: "row" }, openBtn, relBtn), table);
app.append(work, el("div", { class: "card" }, el("h2", {}, "Activity"), el("div", { id: "log" })));

async function refresh(): Promise<void> {
  if (!me) return;
  const s = await auctionSummary(client, auction);
  index = s.members.findIndex((m) => m.toLowerCase() === me!.address.toLowerCase()) + 1;
  if (index === 0) {
    status.textContent = `${me.address} is not on this auction's committee.`;
    return;
  }
  const released = (s.releaseMask & (1 << (index - 1))) !== 0;
  status.textContent = `Member ${index} of ${s.members.length} (threshold ${s.threshold}). Auction is ${s.state}. ${
    released ? "My release is on chain." : s.state === "Closed" ? "Bidding is closed on chain: I may release." : "Releases wait for the on-chain close."
  }`;
  relBtn.disabled = released || s.state !== "Closed";
}

openBtn.onclick = () =>
  guard(openBtn, async () => {
    if (!me || index === 0) throw new Error("choose a member account first");
    const bids = await readBids(client, auction, { rest: cfg.rest });
    const t0 = performance.now();
    opened = openMemberShares({ chainId: BigInt(cfg.chainId), auction, index, keys: me.seal, bids });
    const ms = Math.round(performance.now() - t0);
    const rows = bids.map((b, i) => {
      const bad = opened!.invalid.find((x) => x.bidId === b.bidId);
      return el(
        "tr",
        {},
        el("td", {}, String(b.bidId)),
        el("td", { class: "mono" }, short(b.bidder, 6)),
        el("td", { class: bad ? "bad" : "mono" }, bad ? `flagged: ${bad.reason}` : short(`0x${opened!.shares[i]!.toString(16).padStart(64, "0")}`, 8)),
      );
    });
    table.replaceChildren(
      el("p", { class: "muted" }, `Opened ${bids.length} envelopes with my ML-KEM-1024 + X25519 key in ${ms} ms. Each share is one random number below 2^255 - 19; it reveals nothing about the bid.`),
      el("table", {}, el("tr", {}, el("th", {}, "bid"), el("th", {}, "bidder"), el("th", {}, "my share")), ...rows),
    );
    logLine(`opened ${bids.length} shares (${opened.invalid.length} flagged) in this browser`, "ok");
    await refresh();
  });

relBtn.onclick = () =>
  guard(relBtn, async () => {
    if (!me || index === 0) throw new Error("choose a member account first");
    if (!opened) throw new Error("open my shares first");
    const now = (await client.getBlock()).timestamp;
    const deadline = now + 600n;
    const message = await releaseMessage(client, auction, index, opened, deadline);
    const signature: Hex = signRelease(me.acc.pqc, message);
    logLine(`signed release over ${opened.shares.length} bids with ML-DSA-87 (${(signature.length - 2) / 2} bytes), checked locally`, "ok");
    if (cfg.attestUrl) {
      // Local stack only: the precompile stand-in learns the real ML-DSA-87 verdict first.
      await fetch(cfg.attestUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signer: me.address, signature, message }) });
    }
    const hash = await send(cfg, me, {
      to: auction,
      data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "submitRelease", args: [index, opened.shares, opened.invalidBitmap, deadline, signature] }),
    });
    logLine(`release accepted on chain (pqcVerify), tx ${short(hash)}`, "ok");
    await refresh();
  });
