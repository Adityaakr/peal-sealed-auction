/**
 * Auctions: every auction the factory made, newest first, with its state and
 * links to bid, follow the results, or (for members) release. The open demo
 * auction visitors can bid in is pinned on top.
 */
import { type Address } from "viem";
import { pealTAbi, sealedAuctionFactoryAbi } from "../../../client/abi.ts";
import { $, auctionSummary, carry, el, fail, fmt, header, loadConfig, pageHead, publicClientOf, STATE_WORDS } from "./common.ts";
import { chip, duration, h, icon, type Tone } from "./ui.ts";

const TONE: Record<string, Tone> = { CommitOpen: "wait", Closed: "warn", Settled: "ok", Failed: "bad", Cancelled: "bad", Created: "plain", Funded: "plain" };

try {
  await main();
} catch (e) {
  fail(e);
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  header("Auctions", cfg);
  const client = publicClientOf(cfg);
  const app = $("#app");
  const list = el("div", { class: "auction-list", id: "auctions" }, el("div", { class: "card" }, el("div", { class: "skeleton" }), el("div", { class: "skeleton", style: "width:60%;margin-top:10px" })));
  app.replaceChildren(
    pageHead(
      "Auctions",
      "Sealed auctions on " + (cfg.network === "local" ? "the local node" : "the QoreChain testnet"),
      "Each auction sells one token for another at one uniform price. Bids stay sealed until two of the three committee members release after the close.",
    ),
    list,
  );
  const n = Number(await client.readContract({ address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "auctionCount" }));
  const page = await client.readContract({
    address: cfg.factory,
    abi: sealedAuctionFactoryAbi,
    functionName: "auctionsPaged",
    args: [BigInt(Math.max(0, n - 20)), 20n],
  });
  const listed = [...page].reverse() as Address[];
  if (cfg.demoAuction && !listed.some((a) => a.toLowerCase() === cfg.demoAuction!.toLowerCase())) listed.unshift(cfg.demoAuction);
  if (cfg.demoAuction) listed.sort((a, b) => Number(b.toLowerCase() === cfg.demoAuction!.toLowerCase()) - Number(a.toLowerCase() === cfg.demoAuction!.toLowerCase()));
  const [summaries, now] = await Promise.all([Promise.all(listed.map((a) => auctionSummary(client, a))), client.getBlock().then((b) => b.timestamp)]);
  const tokens = new Map<string, { sym: string; dec: number }>();
  const token = async (t: Address) => {
    const k = t.toLowerCase();
    if (!tokens.has(k)) {
      const [sym, dec] = await Promise.all([client.readContract({ address: t, abi: pealTAbi, functionName: "symbol" }), client.readContract({ address: t, abi: pealTAbi, functionName: "decimals" })]);
      tokens.set(k, { sym, dec: Number(dec) });
    }
    return tokens.get(k)!;
  };
  const cards = await Promise.all(
    listed.map(async (a, i) => {
      const s = summaries[i]!;
      const [sale, quote] = await Promise.all([token(s.cfg.saleToken), token(s.cfg.quoteToken)]);
      const demo = a.toLowerCase() === cfg.demoAuction?.toLowerCase();
      const open = s.state === "CommitOpen" && now < s.cfg.endTime;
      const q = carry(cfg, a);
      const when =
        s.state === "CommitOpen"
          ? open
            ? `closes in ${duration(s.cfg.endTime - now)}`
            : "bidding ended; anyone may close"
          : s.state === "Closed"
            ? `${s.members.filter((_, j) => (s.releaseMask >> j) & 1).length} of ${s.members.length} released`
            : STATE_WORDS[s.state]!;
      return h(
        `div.card.auction-card${demo ? ".is-demo" : ""}`,
        h(
          "div.auction-main",
          h("div.auction-title", demo ? chip("Open to visitors", "wait", "key") : null, h("strong", `${fmt(s.cfg.totalSupply, sale.dec)} ${sale.sym} for ${quote.sym}`)),
          h("div.small.muted", h("span.mono", a), " · ", `${s.bidCount} sealed bid${s.bidCount === 1 ? "" : "s"}`, " · ", when),
        ),
        h(
          "div.auction-side",
          chip(STATE_WORDS[s.state]!, TONE[s.state] ?? "plain"),
          h(
            "div.auction-links",
            open ? h("a.btn.btn-small.btn-primary", { href: `./bidder.html${q}` }, "Place a bid", icon("arrow")) : null,
            h("a.btn.btn-small", { href: `./results.html${q}` }, "Results"),
            s.state === "Closed" ? h("a.btn.btn-small", { href: `./committee.html${q}` }, "Committee") : null,
          ),
        ),
      );
    }),
  );
  list.replaceChildren(...(cards.length ? cards : [h("div.card.empty", "No auctions yet.")]));
}
