/**
 * The landing page, in Peal Sealed Auction's own identity: the sealed envelope.
 *
 * Concept. The visitor is a builder or judge who knows commit-reveal auctions and
 * doubts claims about "encrypted bids". In five seconds the page must land one
 * idea: every bid stays sealed until two of three committee keys meet after the
 * close, and then everyone clears at one price. The metaphor comes from the
 * product itself: the sealed slot. The hero is a vault of the open demo auction's
 * real slots (their actual ciphertexts, read from the chain); the middle shows one
 * slot's anatomy and the keys meeting; the climax is the reveal of the testnet run,
 * where two real ciphertexts open and the clearing price lands.
 *
 * Shared with the other Peal entries: the wordmark and family marks, the footer
 * that links the family, and the base accessibility and spacing rules
 * (docs/design.md in Adityaakr/peal-tender). Everything else is this product's.
 *
 * Every figure is read from the chain or taken from a named transaction.
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { pealTAbi, sealedAuctionAbi, sealedAuctionFactoryAbi } from "../../../client/abi.ts";
import { auctionSummary, loadConfig, netOnly, publicClientOf, startWallet, type AppConfig } from "./config.ts";
import { anatomyArt, anatomyArtPhone, clearingChart, keysArt, keysArtPhone, problemArt, problemArtPhone, timelineArt, timelineArtPhone, type OpenedBid } from "./landing/art.ts";
import { chip, duration, FAMILY, h, hash, icon, mark, type Child } from "./ui.ts";
import { claimPealt, guestPealt, walletButton } from "./wallet/panel.ts";
import { openPanel, state as wallet, subscribe } from "./wallet/store.ts";
import { funded } from "./wallet/guest.ts";

const REPO = "https://github.com/Adityaakr/peal-sealed-auction";
const BLOB = `${REPO}/blob/main`;
const RUN: Address = "0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124";
const RUN_FILE = `${BLOB}/deployments/demo-${RUN}.json`;
const FAUCET_URL = "https://dashboard.qorechain.io/faucet";
const TESTNET_RPC = "https://evm-testnet.qore.host";

const ext = { target: "_blank", rel: "noopener" };
const app = document.getElementById("app")!;
let cfg: AppConfig | undefined;
let cfgError = "";

function appHref(page: string, auction?: Address): string {
  const net = netOnly();
  if (!auction) return `./${page}.html${net}`;
  return `./${page}.html${net ? `${net}&` : "?"}auction=${auction}`;
}

/** A section opens with its index on a rule, then the title. */
function head(index: string, title: Child, lead?: Child): HTMLElement {
  return h("header.sa-head", h("div.sa-index", h("span", index)), h("div.sa-head-text", h("h2.sa-title", title), lead ? h("p.sa-lead", lead) : null));
}

const short = (x: string, a = 6, b = 4) => `${x.slice(0, a + 2)}…${x.slice(-b)}`;

// ---------------------------------------------------------------- navigation

function nav(): HTMLElement {
  const family = h(
    "div.sa-family",
    { role: "group", "aria-label": "Peal products" },
    ...FAMILY.map((p) =>
      h(
        `a.sa-fam${p.id === "auction" ? ".is-current" : ""}`,
        p.id === "auction" ? { href: "#top", "aria-current": "page", title: p.name } : { href: p.href, title: p.name, ...ext },
        mark(p.id, "sa-fam-mark", "dark"),
        h("span.sr-only", p.name),
      ),
    ),
  );
  const bar = h(
    "nav.sa-nav",
    { "aria-label": "Main" },
    h(
      "div.sa-wrap.sa-nav-in",
      h("a.sa-word", { href: "#top" }, mark("auction", "sa-mark", "dark"), h("span", "Peal Sealed Auction")),
      family,
      h(
        "div.sa-links",
        h("a", { href: "#problem" }, "Why"),
        h("a", { href: "#anatomy" }, "How it works"),
        h("a", { href: "#keys" }, "Safety"),
        h("a", { href: "#reveal" }, "Proof"),
        h("a", { href: "#requirements" }, "Requirements"),
        h("a", { href: "#try" }, "Try it"),
        h("a", { href: REPO, ...ext }, "GitHub"),
      ),
      h("div.sa-nav-cta", walletButton(), h("a.sa-btn.sa-btn-brass.sa-btn-s", { href: appHref("auctions") }, "Open the app")),
    ),
  );
  const onScroll = () => bar.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  return bar;
}

// ---------------------------------------------------------------- hero: the vault

function hero(): HTMLElement {
  const tryBtn = h("button.sa-btn.sa-btn-line", { type: "button", id: "hero-try" }, icon("key"), "Try it with a guest account");
  tryBtn.addEventListener("click", () => openPanel());
  return h(
    "section.sa-hero",
    { id: "top" },
    h(
      "div.sa-wrap.sa-hero-grid",
      h(
        "div.sa-hero-copy",
        h("p.sa-tag", h("span.sa-dot", { "aria-hidden": "true" }), "Sealed-bid auction · qorechain-diana · post-quantum"),
        h("h1.sa-display", "Every bid stays sealed until ", h("em", "two of three keys"), " meet."),
        h(
          "p.sa-hero-lead",
          "Bids are encrypted in the bidder's browser. Each bid's key is split across a three-member committee, and each share is sealed with ML-KEM-1024. No single key holder can open a bid before the chain closes bidding. After that, any two members release, with ML-DSA-87 signatures the contract checks itself, and every bid clears at one price.",
        ),
        h("div.sa-ctas", h("a.sa-btn.sa-btn-brass", { href: appHref("bidder", cfg?.demoAuction), id: "hero-bid" }, "Place a sealed bid", icon("arrow")), tryBtn),
      ),
      vault(),
    ),
  );
}

/** The open demo auction's slots: sealed ones carry their real ciphertext. */
function vault(): HTMLElement {
  const slots = h("ol.sa-slots", { id: "vault-slots", "aria-label": "Bid slots of the open demo auction" });
  for (let i = 0; i < 20; i++) slots.append(h("li.sa-slot.is-empty", h("span.sa-slot-n", String(i + 1).padStart(2, "0")), h("span.sa-slot-ct", "open")));
  return h(
    "figure.sa-vault",
    h(
      "div.sa-vault-top",
      h("div", h("div.sa-label", "Open demo auction"), h("div.sa-vault-id", { id: "vault-id" }, cfg?.demoAuction ? short(cfg.demoAuction) : "none open")),
      h("div.sa-vault-right", h("div.sa-label", "Bidding closes in"), h("div.sa-vault-time", { id: "vault-time" }, "…")),
    ),
    slots,
    h(
      "div.sa-vault-keys",
      h("div.sa-keys-row", { "aria-hidden": "true" }, ...[1, 2, 3].map((n) => h("span.sa-key", keyGlyph(), h("span", `member ${n}`)))),
      h("p", "Opens only after ", h("code", "closeCommit"), ", with any two of these three keys."),
    ),
    h("figcaption.sr-only", "Each slot is one bid. A sealed slot shows the first bytes of its ciphertext as stored on chain."),
  );
}

function keyGlyph(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 28 14");
  svg.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(svg.namespaceURI, "circle");
  for (const [k, v] of Object.entries({ cx: "6", cy: "7", r: "4.5", fill: "none", stroke: "currentColor", "stroke-width": "1.5" })) c.setAttribute(k, v);
  const p = document.createElementNS(svg.namespaceURI, "path");
  for (const [k, v] of Object.entries({ d: "M10.5 7H26M21 7v4M25 7v3", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" })) p.setAttribute(k, v);
  svg.append(c, p);
  return svg;
}

// ---------------------------------------------------------------- figures (live)

function figures(): HTMLElement {
  const cell = (label: string, id: string) => h("div.sa-fig", h("span.sa-label", label), h("strong", { id }, "…"), h("span.sa-fig-sub", { id: `${id}-sub` }));
  return h(
    "section.sa-figures",
    { "aria-label": "Live figures" },
    h(
      "div.sa-wrap",
      h(
        "div.sa-fig-row",
        cell("Auctions so far", "pf-auctions"),
        cell("Bids sealed", "pf-bids"),
        cell("Committee", "pf-committee"),
        cell("Open demo auction", "pf-demo"),
      ),
      h("p.sa-source", { id: "pf-note" }, "Reading the chain…"),
    ),
  );
}

async function fillLive(): Promise<void> {
  const set = (id: string, v: string, sub?: string) => {
    const e = document.getElementById(id);
    if (e) e.textContent = v;
    const se = document.getElementById(`${id}-sub`);
    if (se && sub !== undefined) se.textContent = sub;
  };
  if (!cfg) {
    for (const id of ["pf-auctions", "pf-bids", "pf-committee", "pf-demo"]) set(id, "–");
    set("pf-note", `Could not read the chain: ${cfgError}`);
    return;
  }
  try {
    const client = publicClientOf(cfg);
    const [n, block] = await Promise.all([client.readContract({ address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "auctionCount" }), client.getBlock()]);
    const count = Number(n);
    const page = (await client.readContract({ address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "auctionsPaged", args: [BigInt(Math.max(0, count - 20)), 20n] })) as Address[];
    const all = [...page];
    if (cfg.demoAuction && !all.some((a) => a.toLowerCase() === cfg!.demoAuction!.toLowerCase())) all.push(cfg.demoAuction);
    const sums = await Promise.all(all.map((a) => auctionSummary(client, a)));
    set("pf-auctions", count.toLocaleString("en-US"), cfg.network === "local" ? "on the local node" : "made by the factory");
    set("pf-bids", sums.reduce((t0, x) => t0 + x.bidCount, 0).toLocaleString("en-US"), "in the latest 20 auctions");
    set("pf-committee", sums[0] ? `${sums[0].threshold} of ${sums[0].members.length}` : "2 of 3", "ML-DSA-87 joins, checked on chain");
    const di = cfg.demoAuction ? all.findIndex((a) => a.toLowerCase() === cfg!.demoAuction!.toLowerCase()) : -1;
    const demo = di >= 0 ? sums[di] : undefined;
    if (demo && demo.state === "CommitOpen" && block.timestamp < demo.cfg.endTime) {
      const left = duration(demo.cfg.endTime - block.timestamp);
      set("pf-demo", left, `left to bid · ${demo.bidCount} of ${demo.cfg.maxBids} bids`);
      set("vault-time", left);
    } else {
      set("pf-demo", demo ? (demo.state === "Settled" ? "settled" : "closed") : "none open", demo ? "see the results in the app" : "");
      set("vault-time", demo ? "closed" : "–");
    }
    set("pf-note", `Read live from ${cfg.network === "local" ? "the local node" : "qorechain-diana"} at block ${block.number.toLocaleString("en-US")}.`);
    if (demo && cfg.demoAuction) await fillVault(client, cfg.demoAuction, demo.bidCount, demo.cfg.maxBids);
  } catch (e) {
    set("pf-note", `Could not read the chain: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

async function fillVault(client: PublicClient, auction: Address, count: number, maxBids: number): Promise<void> {
  const list = document.getElementById("vault-slots");
  if (!list) return;
  const bids = await Promise.all(
    Array.from({ length: Math.min(count, maxBids) }, (_, i) => client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [BigInt(i)] }) as Promise<{ ct: Hex; bidder: Address }>),
  );
  const mine = wallet.guestStatus?.evm.toLowerCase();
  // The vault shows up to 20 slots, the demo auction's cap on the testnet.
  list.replaceChildren(
    ...Array.from({ length: Math.min(maxBids, 20) }, (_, i) => {
      const b = bids[i];
      if (!b) return h("li.sa-slot.is-empty", h("span.sa-slot-n", String(i + 1).padStart(2, "0")), h("span.sa-slot-ct", "open"));
      return h(
        `li.sa-slot.is-sealed${b.bidder.toLowerCase() === mine ? ".is-mine" : ""}`,
        { title: `bid ${i}: ct ${b.ct}` },
        h("span.sa-slot-n", String(i + 1).padStart(2, "0")),
        h("span.sa-seal", { "aria-hidden": "true" }),
        h("span.sa-slot-ct", b.ct.slice(2, 8)),
      );
    }),
  );
}

// ---------------------------------------------------------------- 01 the problem

function problem(): HTMLElement {
  return h(
    "section.sa-section",
    { id: "problem" },
    h(
      "div.sa-wrap",
      head(
        "01 · The problem",
        "One auction key means one person can read every bid.",
        h(
          "span",
          "QoreChain's documented recipe for sealed bids encrypts every bid to a single auction key. Whoever holds it can read all of them before the close and trade on what they see; if it is lost, nothing opens. Commit-reveal avoids the key but lets a bidder walk away after seeing others. Here each bid gets its own key, and no single party ever holds a whole one.",
        ),
      ),
      h("figure.sa-figure", problemArt(), problemArtPhone()),
    ),
  );
}

// ---------------------------------------------------------------- 02 anatomy

function anatomy(): HTMLElement {
  return h(
    "section.sa-section",
    { id: "anatomy" },
    h(
      "div.sa-wrap",
      head(
        "02 · How a bid is sealed",
        "What the chain holds is 32 bytes of noise and three envelopes.",
        h(
          "span",
          "The bid is quantity and price limit, packed into 32 bytes and XORed with a keystream from a fresh key K. ",
          h("code", "commitBid"),
          " stores the ciphertext and hashes of K and of each share. The shares themselves travel only inside envelopes that one member each can open.",
        ),
      ),
      h("figure.sa-figure", anatomyArt(), anatomyArtPhone()),
      h(
        "dl.sa-facts",
        h("div", h("dt", "Bound to"), h("dd", "chain id, auction, bidder and the bidder's own counter, so nothing replays elsewhere")),
        h("div", h("dt", "Fixed at commit"), h("dd", "no reveal step: the bidder cannot back out after seeing others")),
        h("div", h("dt", "Held in escrow"), h("dd", "the bid's worth rounded up to a shared bucket, because escrow is public, plus a bond; what is not spent comes back, and a bid that opens to junk loses its bond")),
      ),
    ),
  );
}

// ---------------------------------------------------------------- 03 the timeline

function timeline(): HTMLElement {
  return h(
    "section.sa-section",
    { id: "timeline" },
    h(
      "div.sa-wrap",
      head(
        "03 · When a bid can be read",
        h("span", "The chain decides when bids open, ", h("em", "not a clock or a person"), "."),
        h(
          "span",
          "Members release only in state ",
          h("code", "Closed"),
          ", which ",
          h("code", "closeCommit"),
          " enters after the end time. Releases are accepted until the release deadline; then ",
          h("code", "openBids"),
          " and ",
          h("code", "finalize"),
          " run, and anyone may call them. If nobody finalizes within 3 days of the deadline, anyone can fail the auction and everyone is refunded.",
        ),
      ),
      h("figure.sa-figure", timelineArt(), timelineArtPhone()),
    ),
  );
}

// ---------------------------------------------------------------- 04 keys

const MEMBERS: { n: number; addr: Address; kem: string; release?: string }[] = [
  { n: 1, addr: "0x64eE2394BE93B0e840b06fd497df90E5295786Ee", kem: "0x602d1000…b4bf0a8d", release: "0xc999a0c26b698e64836486c637f3e126e11317d1ca06cf4e6b00c63d8293ee68" },
  { n: 2, addr: "0x75588D0B6117D3C05694B656228508D461A996c4", kem: "0x13997af9…7fce819e", release: "0xcc039c7dd19f1d0626dea38d42834140d228c686d22ce1ff693950d9e0113007" },
  { n: 3, addr: "0x0E7db45Da1fD3d974218E59CF8C4387789fF1714", kem: "0xca620568…b3f0a35b" },
];

function keys(): HTMLElement {
  const refused: [string, string, string][] = [
    ["A release signed by an outsider's ML-DSA-87 key", "ReleaseSignatureInvalid", "testnet, live pqcVerify"],
    ["A REST proxy swapping member 2's ML-KEM key", "rejected by the bidder", "key hash signed into the registry"],
    ["A release before the chain closes bidding", "refused", "releases need state Closed"],
    ["Finalizing while a release can still arrive", "TooEarly", "local run with real keys"],
    ["A bid that opens to junk", "excluded, bond burned", "the auction goes on"],
  ];
  return h(
    "section.sa-section",
    { id: "keys" },
    h(
      "div.sa-wrap",
      head(
        "04 · Why no single member opens it early",
        h("span", "Any two of three keys open every bid. ", h("em", "One opens nothing.")),
        h(
          "span",
          "A share alone is one random number below 2",
          h("sup", "255"),
          " − 19. Members can release only after ",
          h("code", "closeCommit"),
          ", each signing one release over all the bids. The contract checks every signature with ",
          h("code", "pqcVerify"),
          " against the key ",
          h("code", "pqcKeyStatus"),
          " reports, so a forged release reverts and a missing member changes nothing.",
        ),
      ),
      h("figure.sa-figure", keysArt(), keysArtPhone()),
      h(
        "div.sa-split",
        h(
          "div.sa-table-wrap",
          h("h3.sa-h3", "The committee on the testnet"),
          h(
            "table.sa-table",
            h("thead", h("tr", h("th", "Member"), h("th", "Account"), h("th", "ML-KEM key, SHA3-256"), h("th", "Release in the run"))),
            h(
              "tbody",
              ...MEMBERS.map((mm) =>
                h(
                  "tr",
                  h("td", String(mm.n)),
                  h("td", hash(mm.addr, { label: `member ${mm.n} account` })),
                  h("td.sa-mono", mm.kem),
                  h("td", mm.release ? hash(mm.release, { label: `member ${mm.n} release` }) : h("span.sa-muted", "offline in the run")),
                ),
              ),
            ),
          ),
          h("p.sa-source", "In this demo one owner holds all three keys, as separate accounts: it shows the mechanism, not the independence. Set ", h("code", "0xd6da2884…0fe5"), ", registered with three ML-DSA-87 joins checked by pqcVerify. From ", h("a", { href: `${BLOB}/deployments/qorechain-diana.json`, ...ext }, "deployments/qorechain-diana.json"), "."),
        ),
        h(
          "div.sa-table-wrap",
          h("h3.sa-h3", "What it refuses"),
          h(
            "table.sa-table.sa-refusals",
            h("thead", h("tr", h("th", "Attempt"), h("th", "Result"))),
            h("tbody", ...refused.map(([a, r, why]) => h("tr", h("td", a, h("span.sa-why", why)), h("td.sa-refused", r)))),
          ),
          h("p.sa-source", "From the testnet run and ", h("a", { href: `${BLOB}/scripts/e2e-local.ts`, ...ext }, "npm run e2e:local"), ". Every defence and its test: ", h("a", { href: `${BLOB}/THREAT_MODEL.md`, ...ext }, "threat model"), "."),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- 03 the reveal

interface Reveal {
  bids: { label: string; ct: Hex; quantity: number; price: number; allocated: number }[];
  supply: number;
  price: number;
  sale: string;
  quote: string;
  live: boolean;
}

/** The testnet run as recorded (deployments/demo-0x9CbA…json), used if the chain cannot be read. */
const RECORDED: Reveal = {
  bids: [
    { label: "bid 0", ct: "0xbaec6c2031f3406ae6eead15879afdc0d468ce2f10b2d9d89928f7b081c6a659", quantity: 60, price: 2.5, allocated: 60 },
    { label: "bid 1", ct: "0x8b3a537ce28c4b6361a75c315a8dae925239283c92493c076eb62d871727b713", quantity: 70, price: 1.5, allocated: 40 },
  ],
  supply: 100,
  price: 1.5,
  sale: "PEAL-T",
  quote: "fUSD",
  live: false,
};

async function readReveal(): Promise<Reveal> {
  try {
    const c = createPublicClient({ transport: http(TESTNET_RPC) });
    const read = <T>(functionName: string, args: unknown[] = []) => c.readContract({ address: RUN, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;
    type B = { ct: Hex; quantity: bigint; tick: number };
    type Cfg = { reservePrice: bigint; tickSize: bigint; totalSupply: bigint; saleToken: Address; quoteToken: Address };
    const [conf, count, price] = await Promise.all([read<Cfg>("config"), read<number>("bidCount"), read<bigint>("clearingPrice")]);
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
    const [bids, allocs, sd, qd, ss, qs] = await Promise.all([
      Promise.all(ids.map((i) => read<B>("getBid", [i]))),
      Promise.all(ids.map((i) => read<bigint>("allocationOf", [i]))),
      c.readContract({ address: conf.saleToken, abi: pealTAbi, functionName: "decimals" }),
      c.readContract({ address: conf.quoteToken, abi: pealTAbi, functionName: "decimals" }),
      c.readContract({ address: conf.saleToken, abi: pealTAbi, functionName: "symbol" }),
      c.readContract({ address: conf.quoteToken, abi: pealTAbi, functionName: "symbol" }),
    ]);
    const n = (v: bigint, d: number) => Number(v) / 10 ** d;
    return {
      bids: bids.map((b, i) => ({
        label: `bid ${i}`,
        ct: b.ct,
        quantity: n(b.quantity, Number(sd)),
        price: n(conf.reservePrice + BigInt(b.tick) * conf.tickSize, Number(qd)),
        allocated: n(allocs[i]!, Number(sd)),
      })),
      supply: n(conf.totalSupply, Number(sd)),
      price: n(price, Number(qd)),
      sale: ss,
      quote: qs,
      live: true,
    };
  } catch {
    return RECORDED;
  }
}

/** The ledger of the testnet run, transaction by transaction. */
const LEDGER: { call: string; by: string; gas?: number; tx?: string; note: string; bad?: boolean }[] = [
  { call: "createAuction", by: "issuer", gas: 683_712, tx: "0x4a82f343731d4d4cb831f13056a02b2d2c3f5876253211954eb8e938f49c012d", note: "100 PEAL-T for fUSD, funded and opened in one call" },
  { call: "commitBid", by: "bidder 1", gas: 439_397, tx: "0x5f6bde8fc367cec8d9b374c55f783ebefbfff03b6bfea0118aca3e2d8f4c4584", note: "32-byte ciphertext, 3 share hashes, 3 × 1,752 B envelopes" },
  { call: "commitBid", by: "bidder 2", gas: 405_257, tx: "0x669cf22f523984d04a266686a7f4686bc546aabc384e40082b7caa38fbba4f1b", note: "a second sealed bid" },
  { call: "closeCommit", by: "anyone", gas: 34_618, tx: "0xfd967fc0a48ed1305bcfad46d14c904654e22bd3fd8ceda9b45c63ac964a5740", note: "the bid set is frozen" },
  { call: "submitRelease", by: "outsider", note: "ReleaseSignatureInvalid, from the live pqcVerify (simulated, no gas)", bad: true },
  { call: "submitRelease", by: "member 1", gas: 285_063, tx: "0xc999a0c26b698e64836486c637f3e126e11317d1ca06cf4e6b00c63d8293ee68", note: "one ML-DSA-87 signature over both bids" },
  { call: "submitRelease", by: "member 2", gas: 285_195, tx: "0xcc039c7dd19f1d0626dea38d42834140d228c686d22ce1ff693950d9e0113007", note: "member 3 stays offline" },
  { call: "openBids", by: "anyone", gas: 286_277, tx: "0xdad46c9202d8287b98b697847c5aca1a82a4b1e624f603dfebfff7cca8db365c", note: "K rebuilt from two shares; both bids decrypted on chain" },
  { call: "finalize", by: "anyone", gas: 235_710, tx: "0x85a2df47dbf5a5cf5d4473db222170432c568990bdda03b1f4847e4e9045e44d", note: "one uniform price" },
];

function reveal(): HTMLElement {
  const stage = h("div.sa-stage", { id: "reveal-stage" }, h("div.sa-skel"));
  const replay = h("button.sa-btn.sa-btn-line.sa-btn-s", { type: "button", id: "reveal-replay" }, "Seal them again");
  const sec = h(
    "section.sa-section.sa-reveal",
    { id: "reveal" },
    h(
      "div.sa-wrap",
      head(
        "05 · Live proof: the reveal",
        "Two ciphertexts open, and one price clears them.",
        h("span", "Auction ", hash(RUN, { label: "the testnet run's auction" }), " on 16 November 2026: two sealed bids, member 3 offline, an outsider's forged release refused. Then the contract rebuilt each K, decrypted both bids and cleared them."),
      ),
      stage,
      h(
        "div.sa-ledger",
        h("div.sa-ledger-head", h("h3.sa-h3", "Every transaction of the run"), h("a", { href: RUN_FILE, ...ext }, "deployments/demo-0x9CbA…c124.json ", icon("out"))),
        h(
          "div.sa-table-scroll",
          h(
            "table.sa-table.sa-ledger-table",
            h("thead", h("tr", h("th", "Call"), h("th", "By"), h("th", "What happened"), h("th.num", "Gas"), h("th", "Transaction"))),
            h(
              "tbody",
              ...LEDGER.map((r) =>
                h(
                  `tr${r.bad ? ".is-refused" : ""}`,
                  h("td.sa-mono", r.call),
                  h("td.sa-muted", r.by),
                  h("td", r.note),
                  h("td.num.sa-mono", r.gas ? r.gas.toLocaleString("en-US") : "–"),
                  h("td", r.tx ? hash(r.tx, { label: `${r.call} transaction` }) : h("span.sa-refused", "refused")),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  void readReveal().then((data) => {
    const cards = h(
      "div.sa-opened",
      ...data.bids.map((b) =>
        h(
          "div.sa-env",
          h("div.sa-env-top", h("span.sa-label", b.label), h("span.sa-env-state")),
          h("div.sa-env-ct.sa-mono", { title: b.ct }, `${b.ct.slice(0, 18)}…${b.ct.slice(-8)}`),
          h("div.sa-env-pt", h("strong", `${b.quantity} ${data.sale}`), h("span", `at most ${b.price.toFixed(2)} ${data.quote} each`)),
          h("div.sa-env-alloc", `allocated ${b.allocated}, pays ${data.price.toFixed(2)} each`),
        ),
      ),
    );
    const sold = data.bids.reduce((sum, b) => sum + b.allocated, 0);
    stage.replaceChildren(
      h(
        "div.sa-stage-left",
        cards,
        h(
          "div.sa-price",
          h("span.sa-label", "Clearing price"),
          h("div.sa-price-n", h("span", { id: "reveal-price" }, data.price.toFixed(2)), h("small", ` ${data.quote}`)),
          h("p", `per ${data.sale}, the same for every winner: ${sold} of ${data.supply} sold for ${(sold * data.price).toLocaleString("en-US")} ${data.quote}. Escrow above that came back.`),
          replay,
        ),
      ),
      h(
        "figure.sa-chart",
        clearingChart(
          data.bids.map<OpenedBid>((b) => ({ label: b.label, quantity: b.quantity, price: b.price, allocated: b.allocated })),
          data.supply,
          data.price,
          { sale: data.sale, quote: data.quote },
        ),
        clearingChart(
          data.bids.map<OpenedBid>((b) => ({ label: b.label, quantity: b.quantity, price: b.price, allocated: b.allocated })),
          data.supply,
          data.price,
          { sale: data.sale, quote: data.quote },
          true,
        ),
        h("figcaption.sa-source", data.live ? "Read live from the auction on qorechain-diana. Filled: allocated. Outlined: unfilled." : "From the recorded run; the chain could not be read just now."),
      ),
    );
    armReveal(sec);
  });
  replay.addEventListener("click", () => {
    sec.classList.add("is-sealed");
    window.setTimeout(() => sec.classList.remove("is-sealed"), 900);
  });
  return sec;
}

/** With motion allowed, the bids show sealed until the section is in view, then open once. */
function armReveal(sec: HTMLElement): void {
  if (!window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches || !("IntersectionObserver" in window)) return;
  const r = sec.getBoundingClientRect();
  if (r.top < window.innerHeight * 0.6 && r.bottom > 0) return; // already in view: show it open
  sec.classList.add("is-sealed");
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      window.setTimeout(() => sec.classList.remove("is-sealed"), 350);
    },
    { threshold: 0.35 },
  );
  io.observe(sec.querySelector(".sa-stage")!);
}

// ---------------------------------------------------------------- 06 requirements

function requirements(): HTMLElement {
  const tx = (v: string, label: string) => hash(v, { label });
  const rows: [string, Child, Child][] = [
    [
      "ML-KEM-1024 encryption",
      "Every key share is a QoreSeal hybrid envelope (ML-KEM-1024 + X25519) to one member: 1,752 bytes each, three per bid.",
      h("span", "commitBid ", tx("0x5f6bde8fc367cec8d9b374c55f783ebefbfff03b6bfea0118aca3e2d8f4c4584", "commitBid"), "; an outsider opens nothing (", h("code", "test-ts"), ")"),
    ],
    [
      "Registered recipient keys",
      h("span", "Members publish their ML-KEM keys with ", h("code", "MsgRegisterKEMKey"), ". Bidders read them from REST and accept one only if its SHA3-256 matches the hash the member signed into the registry."),
      h("span", tx("1E5640C6AC80A5AAC3EF214056D5117FAE41EDB35C75B486B8C7C8EFC586C4DE", "member 1 key registration"), " ", tx("C8BE6A24FE522CEA2ED85100E19D9B1D9839C4E2EBF5C93248EDA5F4262F4858", "member 2 key registration"), " ", tx("8E451CFD38F8D0E53C8E7DA5CED9B614A5E7DD569DAAB1A5B4A590EC6D72D93A", "member 3 key registration")),
    ],
    [
      "ML-DSA key binding",
      h("span", "Each member's join is an ML-DSA-87 signature binding its ML-KEM key hash to the set, checked by ", h("code", "pqcVerify"), "; every release is ML-DSA-87 signed and checked the same way."),
      h("span", "registerSet ", tx("0x470ce18a4e0ba1782ca737381f18535ca6169b5b8908b53680e0454c17b0b593", "registerSet"), "; releases above"),
    ],
    [
      "Client-side encryption and decryption",
      "Bids are sealed in the bidder's browser. Each member opens its own shares and signs its release in its own browser or daemon. Keys never leave them.",
      h("span", "a guest's bid sealed in this site ", tx("0x6041fd76a6f919f43f34e5780a575ad7a8c3d1c11cc201792f92c37dbc0d7ba3", "guest commitBid"), "; ", h("code", "npm run web:smoke"), " in CI"),
    ],
  ];
  return h(
    "section.sa-section",
    { id: "requirements" },
    h(
      "div.sa-wrap",
      head("06 · Requirements", "Each requirement, met where you can check it.", "QoreChain's Build Before Q-Day fest lists four requirements for the Encrypted Apps category. Every row links to a transaction on qorechain-diana or a test in the repository."),
      h(
        "div.sa-table-scroll",
        h(
          "table.sa-table.sa-req",
          h("thead", h("tr", h("th", "Requirement"), h("th", "How it is met"), h("th", "Evidence"))),
          h("tbody", ...rows.map(([a, b, c]) => h("tr", h("td.sa-req-name", a), h("td", b), h("td", c)))),
        ),
      ),
      h("p.sa-source", "Full table with tests: ", h("a", { href: `${REPO}#the-categorys-requirements-with-evidence`, ...ext }, "README"), "."),
    ),
  );
}

// ---------------------------------------------------------------- 07 try it

function tryIt(): HTMLElement {
  const list = h("ol.sa-try");
  const draw = () => {
    const g = wallet.guestStatus;
    const has = Boolean(g);
    const isFunded = g ? funded(g) : false;
    const hasPealt = (guestPealt() ?? 0n) > 0n;
    const local = cfg?.network === "local";
    const state = (done: boolean, now: boolean) => (done ? chip("done", "ok") : now ? chip("next", "wait", "arrow") : h("span.sa-muted.sa-small", "to do"));
    const row = (n: number, title: string, body: Child, st: HTMLElement, ...cta: Child[]) =>
      h("li", h("span.sa-try-n", String(n)), h("div.sa-try-text", h("div.sa-try-title", h("span", title), st), h("p", body)), h("div.sa-try-cta", ...cta));
    const create = h(`button.sa-btn.sa-btn-s${has ? ".sa-btn-line" : ".sa-btn-brass"}`, { type: "button", id: "try-create" }, icon("key"), has ? "Open the wallet" : "Create a guest account");
    create.addEventListener("click", () => openPanel());
    const claim = h(`button.sa-btn.sa-btn-s${has && isFunded && !hasPealt ? ".sa-btn-brass" : ".sa-btn-line"}`, { type: "button", id: "try-pealt", disabled: !has || !isFunded || Boolean(wallet.busy) ? true : undefined }, "Claim 1,000 PEAL-T");
    claim.addEventListener("click", () => void claimPealt());
    list.replaceChildren(
      row(1, "Make a guest account", "A fresh testnet key pair made in this browser, with its own ML-DSA-87 key. Back it up or forget it from the wallet.", state(has, !has), create),
      row(
        2,
        "Fund it with test QOR",
        local ? "On the local node, one click in the wallet adds 10 test QOR." : h("span", "Claim from the QoreChain faucet to the guest's ", h("code", "qor1…"), " address, or send from QoreX. A whole first bid measured 0.51 QOR."),
        state(isFunded, has && !isFunded),
        local ? null : h("a.sa-btn.sa-btn-line.sa-btn-s", { href: FAUCET_URL, ...ext }, "Dashboard faucet", icon("out")),
      ),
      row(3, "Get test PEAL-T", "The demo auction sells fUSD for PEAL-T. The demo faucet gives each address 1,000 a day; the first action also registers the guest's key.", state(hasPealt, isFunded && !hasPealt), claim),
      row(
        4,
        "Seal and commit a bid",
        "Check the committee's keys, choose a quantity and a price limit, and commit. Approve and commitBid go out in one window scoped to the token and the auction.",
        state(false, hasPealt),
        h(`a.sa-btn.sa-btn-s${hasPealt ? ".sa-btn-brass" : ".sa-btn-line"}`, { href: appHref("bidder", cfg?.demoAuction), id: "try-bid" }, "Bid in the demo auction", icon("arrow")),
      ),
    );
  };
  subscribe(draw);
  draw();
  return h(
    "section.sa-section",
    { id: "try" },
    h(
      "div.sa-wrap",
      head(
        "07 · Try it",
        "Seal a bid of your own in about five minutes.",
        h("span", "On the QoreChain testnet, with test tokens; your keys stay in this browser. After the close, the demo committee releases with ", h("code", "npm run testnet -- settle"), " and your slot opens on the results page."),
      ),
      list,
    ),
  );
}

// ---------------------------------------------------------------- family and footer (shared Peal layer)

function footer(): HTMLElement {
  const col = (title: string, ...links: [string, string, boolean?][]) =>
    h("div.sa-foot-col", h("h4", title), ...links.map(([t0, href, isExt]) => h("a", isExt ? { href, ...ext } : { href }, t0)));
  return h(
    "footer.sa-foot",
    h(
      "div.sa-wrap",
      h(
        "div.sa-family-list",
        h("div.sa-label.sa-family-label", mark("peal", "sa-peal-mark", "dark"), "The Peal family"),
        ...FAMILY.map((p) =>
          h(
            `a.sa-family-row${p.id === "auction" ? ".is-current" : ""}`,
            p.id === "auction" ? { href: "#top" } : { href: p.href, ...ext },
            mark(p.id, "sa-mark", "dark"),
            h("strong", p.name, h("span.sa-role", `: ${p.role}`)),
            h("span", p.line),
            p.id === "auction" ? h("em", "you are here") : icon("out"),
          ),
        ),
      ),
      h(
        "div.sa-foot-grid",
        h("div", h("a.sa-word", { href: "#top" }, mark("auction", "sa-mark", "dark"), "Peal Sealed Auction"), h("p", "A uniform-price sealed-bid auction on QoreChain whose bids no single key holder can open before the close.")),
        col("Product", ["Auctions", appHref("auctions")], ["Place a bid", appHref("bidder", cfg?.demoAuction)], ["Results", appHref("results", cfg?.demoAuction)], ["Committee", appHref("committee")], ["Open an auction", appHref("issuer")]),
        col("Developers", ["GitHub", REPO, true], ["Threat model", `${BLOB}/THREAT_MODEL.md`, true], ["Testnet findings", `${BLOB}/docs/spikes.md`, true], ["qore-pq-kit", "https://github.com/Adityaakr/qore-pq-kit", true]),
        col("Network", ["QoreChain", "https://qorechain.io", true], ["Testnet faucet", FAUCET_URL, true], ["How AI built this", `${BLOB}/AI_USAGE.md`, true]),
      ),
      h("div.sa-foot-base", h("span", "Apache-2.0 · testnet only, not audited"), h("span", "Design language started from Peal")),
    ),
  );
}

// ---------------------------------------------------------------- page

async function main(): Promise<void> {
  try {
    cfg = await loadConfig();
  } catch (e) {
    cfgError = e instanceof Error ? e.message : String(e);
  }
  if (cfg) startWallet(cfg);
  app.replaceChildren(nav(), h("main", hero(), figures(), problem(), anatomy(), timeline(), keys(), reveal(), requirements(), tryIt()), footer());
  if (window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches) document.documentElement.classList.add("motion");
  void fillLive();
}

void main();
