import { sealedAuctionFactoryAbi } from "../../../client/abi.ts";
import { $, auctionSummary, el, header, loadConfig, publicClientOf } from "./common.ts";

const cfg = await loadConfig();
header("Peal Sealed Auction", cfg);
const client = publicClientOf(cfg);
const app = $("#app");
app.replaceChildren(
  el(
    "div",
    { class: "card" },
    el("h1", {}, "Peal Sealed Auction"),
    el(
      "p",
      {},
      "Uniform-price sealed bids that no single key holder can open before the close. Each bid is encrypted under a fresh key K; K is split 2-of-3 and every share is sealed with ML-KEM-1024 + X25519 to one committee member's registered key. After the on-chain close, members release their shares with ML-DSA-87 signatures, and the contract rebuilds K and decrypts the bids itself.",
    ),
  ),
);
const list = el("div", { class: "card" }, el("h2", {}, "Auctions"));
app.append(list);
const n = Number(await client.readContract({ address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "auctionCount" }));
const page = await client.readContract({
  address: cfg.factory,
  abi: sealedAuctionFactoryAbi,
  functionName: "auctionsPaged",
  args: [BigInt(Math.max(0, n - 20)), 20n],
});
if (page.length === 0) list.append(el("p", { class: "muted" }, "No auctions yet."));
const q = new URLSearchParams(location.search);
for (const a of [...page].reverse()) {
  const s = await auctionSummary(client, a);
  q.set("auction", a);
  list.append(
    el(
      "div",
      { class: "row" },
      el("span", { class: "mono" }, a),
      el("span", {}, s.state),
      el("span", { class: "muted" }, `${s.bidCount} bids`),
      el("a", { href: `./bidder.html?${q}` }, "bid"),
      el("a", { href: `./committee.html?${q}` }, "committee"),
      el("a", { href: `./results.html?${q}` }, "results"),
    ),
  );
}
