/**
 * The landing page (docs/design.md in Adityaakr/peal-tender, "Landing pages"):
 * navigation, hero with the mechanism, live proof bar, the step rail, security on
 * the dark band, roles, try it, the Peal family, and the footer.
 *
 * Every figure is read from the chain or labelled as the testnet demo run's.
 * Every button goes somewhere real: the app pages, the guest account, the repository.
 */
import { type Address } from "viem";
import { pealTAbi, sealedAuctionAbi, sealedAuctionFactoryAbi } from "../../../client/abi.ts";
import { auctionSummary, loadConfig, netOnly, publicClientOf, startWallet, type AppConfig } from "./config.ts";
import { heroArt, heroArtPhone, PANELS, railArt } from "./landing/art.ts";
import { chip, duration, FAMILY, h, icon, mark, price2, s, type Child } from "./ui.ts";
import { claimPealt, guestPealt, walletButton } from "./wallet/panel.ts";
import { openPanel, state as wallet, subscribe } from "./wallet/store.ts";
import { funded } from "./wallet/guest.ts";

const REPO = "https://github.com/Adityaakr/peal-sealed-auction";
const BLOB = `${REPO}/blob/main`;
const DEMO_RUN = `${BLOB}/deployments/demo-0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124.json`;
const FAUCET_URL = "https://dashboard.qorechain.io/faucet";

const ext = { target: "_blank", rel: "noopener" };
const app = document.getElementById("app")!;
let cfg: AppConfig | undefined;
let cfgError = "";

function appHref(page: string, auction?: Address): string {
  const net = netOnly();
  if (!auction) return `./${page}.html${net}`;
  return `./${page}.html${net ? `${net}&` : "?"}auction=${auction}`;
}

function kicker(t: string): HTMLElement {
  return h("div.kicker", t);
}

function sectionHead(k: string, title: Child, lead?: Child): HTMLElement {
  return h("div.section-head", kicker(k), h("h2.l-title", title), lead ? h("p.lead", lead) : null);
}

// ---------------------------------------------------------------- navigation

function nav(): HTMLElement {
  const family = h(
    "div.family-switch",
    { role: "group", "aria-label": "Peal products" },
    ...FAMILY.map((p) =>
      h(
        `a.fam${p.id === "auction" ? ".is-current" : ""}`,
        p.id === "auction" ? { href: "#top", "aria-current": "page", title: p.name } : { href: p.href, title: p.name, ...ext },
        mark(p.id, "fam-mark"),
        h("span.sr-only", p.name),
      ),
    ),
  );
  const bar = h(
    "nav.l-nav",
    { "aria-label": "Main" },
    h(
      "div.l-wrap.l-nav-in",
      h("a.wordmark", { href: "#top" }, mark("auction"), h("span", "Peal Sealed Auction")),
      family,
      h(
        "div.l-anchors",
        h("a", { href: "#how" }, "How it works"),
        h("a", { href: "#security" }, "Security"),
        h("a", { href: "#try" }, "Try it"),
        h("a.gh", { href: REPO, ...ext, "aria-label": "GitHub repository" }, icon("github"), h("span", "GitHub")),
      ),
      h("div.l-nav-cta", walletButton(), h("a.btn.btn-small.btn-primary", { href: appHref("auctions") }, "Open the app")),
    ),
  );
  const onScroll = () => bar.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  return bar;
}

// ---------------------------------------------------------------- hero

function hero(): HTMLElement {
  const tryBtn = h("button.btn.btn-l", { type: "button", id: "hero-try" }, icon("key"), "Try it with a guest account");
  tryBtn.addEventListener("click", () => openPanel());
  return h(
    "section.l-hero",
    { id: "top" },
    h(
      "div.l-wrap.hero-grid",
      h(
        "div.hero-copy",
        h("div.rise", kicker("Encrypted Apps · Build Before Q-Day")),
        h("h1.display.rise", "Sealed bids ", h("span.accent", "no one can open early"), "."),
        h(
          "p.lead.rise",
          "Each bid is locked under its own key, split two of three across a committee and sealed to each member with ML-KEM-1024. Only after the chain closes the auction can any two of them release it, with ML-DSA-87 signatures the contract checks itself.",
        ),
        h(
          "div.btn-pair.rise",
          h("a.btn.btn-l.btn-primary", { href: appHref("bidder", cfg?.demoAuction), id: "hero-bid" }, "Place a sealed bid", icon("arrow")),
          tryBtn,
        ),
        h("p.proof-line.rise", "Live on qorechain-diana · Apache-2.0 · 105 Solidity tests · sealing runs in your browser"),
      ),
      h("figure.hero-figure", heroArt(), heroArtPhone(), h("figcaption.sr-only", "How a sealed bid travels: browser, committee, chain.")),
    ),
  );
}

// ---------------------------------------------------------------- proof bar (live)

function proofBar(): HTMLElement {
  const cell = (label: string, id: string, sub?: string) =>
    h("div.proof-cell", h("span.cap", label), h("strong.fig", { id }, h("span.skeleton.sk-fig")), sub ? h("span.cap.sub", { id: `${id}-sub` }, sub) : h("span.cap.sub", { id: `${id}-sub` }));
  const bar = h(
    "section.l-proof",
    { "aria-label": "Live figures" },
    h(
      "div.l-wrap",
      h(
        "div.proof-bar",
        cell("Auctions so far", "pf-auctions"),
        cell("Bids sealed", "pf-bids"),
        cell("Committee", "pf-committee"),
        cell("Last clearing price", "pf-price"),
        cell("Open demo auction", "pf-demo"),
      ),
      h("div.proof-note", h("span.live-dot", { "aria-hidden": "true" }), h("span", { id: "pf-note" }, "Reading the chain…")),
    ),
  );
  return bar;
}

async function fillProof(): Promise<void> {
  const set = (id: string, v: string, sub?: string) => {
    const e = document.getElementById(id);
    if (e) e.textContent = v;
    const sEl = document.getElementById(`${id}-sub`);
    if (sEl && sub !== undefined) sEl.textContent = sub;
  };
  if (!cfg) {
    for (const id of ["pf-auctions", "pf-bids", "pf-committee", "pf-price", "pf-demo"]) set(id, "–");
    set("pf-note", `Could not read the chain: ${cfgError}`);
    return;
  }
  try {
    const client = publicClientOf(cfg);
    const [n, block] = await Promise.all([
      client.readContract({ address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "auctionCount" }),
      client.getBlock(),
    ]);
    const count = Number(n);
    const page = (await client.readContract({ address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "auctionsPaged", args: [BigInt(Math.max(0, count - 20)), 20n] })) as Address[];
    const all = [...page];
    if (cfg.demoAuction && !all.some((a) => a.toLowerCase() === cfg!.demoAuction!.toLowerCase())) all.push(cfg.demoAuction);
    const sums = await Promise.all(all.map((a) => auctionSummary(client, a)));
    set("pf-auctions", count.toLocaleString("en-US"), cfg.network === "local" ? "on the local node" : "on the QoreChain testnet");
    set("pf-bids", sums.reduce((t, x) => t + x.bidCount, 0).toLocaleString("en-US"), "in the latest 20 auctions");
    const th = sums[0] ? `${sums[0].threshold} of ${sums[0].members.length}` : "2 of 3";
    set("pf-committee", th, "ML-DSA-87 joins, checked on chain");
    const settledIdx = [...sums.keys()].reverse().find((i) => sums[i]!.state === "Settled");
    if (settledIdx !== undefined) {
      const a = all[settledIdx]!;
      const sm = sums[settledIdx]!;
      const [price, qd, qs, ss] = await Promise.all([
        client.readContract({ address: a, abi: sealedAuctionAbi, functionName: "clearingPrice" }) as Promise<bigint>,
        client.readContract({ address: sm.cfg.quoteToken, abi: pealTAbi, functionName: "decimals" }),
        client.readContract({ address: sm.cfg.quoteToken, abi: pealTAbi, functionName: "symbol" }),
        client.readContract({ address: sm.cfg.saleToken, abi: pealTAbi, functionName: "symbol" }),
      ]);
      set("pf-price", price2(price, Number(qd)), `${qs} per ${ss}, one price for every winner`);
    } else set("pf-price", "none yet", "no auction has settled");
    const demoIdx = cfg.demoAuction ? all.findIndex((a) => a.toLowerCase() === cfg!.demoAuction!.toLowerCase()) : -1;
    const demo = demoIdx >= 0 ? sums[demoIdx] : undefined;
    if (demo && demo.state === "CommitOpen" && block.timestamp < demo.cfg.endTime) set("pf-demo", duration(demo.cfg.endTime - block.timestamp), `left to bid · ${demo.bidCount} of ${demo.cfg.maxBids} bids so far`);
    else if (demo) set("pf-demo", demo.state === "Settled" ? "settled" : "closed", "see its results in the app");
    else set("pf-demo", "none open", "the next one opens soon");
    set("pf-note", `Read live from ${cfg.network === "local" ? "the local node" : "qorechain-diana"} at block ${block.number.toLocaleString("en-US")}.`);
  } catch (e) {
    set("pf-note", `Could not read the chain: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

// ---------------------------------------------------------------- how it works: the step rail

const STEPS: { title: string; body: Child[] }[] = [
  {
    title: "Seal, in your browser",
    body: ["Your bid is encrypted under a fresh key K. K is split into three shares, and each share is sealed with ML-KEM-1024 + X25519 to one member's registered key. The plaintext never leaves the tab."],
  },
  {
    title: "Commit, on chain",
    body: [h("span.mono", "commitBid"), " stores the ciphertext and the hashes of K and of every share, emits the envelopes, and pulls your escrow and a small bond. The bid is fixed: there is no reveal step to skip."],
  },
  {
    title: "Release, after the close",
    body: ["Once ", h("span.mono", "closeCommit"), " freezes the bids, each member opens its shares and signs one release over all of them with ML-DSA-87. The contract checks it with ", h("span.mono", "pqcVerify"), "; a forged one reverts."],
  },
  {
    title: "Open and clear",
    body: ["Any two shares rebuild K. The contract checks it against H(K), decrypts every bid itself and clears them all at one uniform price. A bid that cannot open is refunded, never fatal."],
  },
];

function stepRail(): HTMLElement {
  const art = railArt();
  const panels = [...art.querySelectorAll<SVGGElement>("g.panel")];
  const items: HTMLElement[] = [];
  let active = 0;
  const choose = (i: number, focus = false) => {
    active = i;
    items.forEach((it, j) => {
      it.classList.toggle("is-active", j === i);
      it.setAttribute("aria-selected", j === i ? "true" : "false");
      it.tabIndex = j === i ? 0 : -1;
    });
    panels.forEach((p, j) => p.classList.toggle("is-dim", j !== i));
    if (focus) items[i]!.focus();
  };
  const list = h("div.rail-steps", { role: "tablist", "aria-label": "How it works, step by step", "aria-orientation": "vertical" });
  STEPS.forEach((st, i) => {
    // On a phone each step carries its own crop of the drawing.
    const crop = railArt();
    const [x, y, w, hh] = PANELS[i]!;
    crop.setAttribute("viewBox", `${x - 4} ${y - 4} ${w + 8} ${hh + 8}`);
    crop.setAttribute("aria-hidden", "true");
    crop.removeAttribute("role");
    crop.classList.add("rail-crop");
    const item = h(
      "button.rail-step",
      { type: "button", role: "tab", id: `step-${i + 1}`, "aria-controls": "rail-figure" },
      h("span.rail-n", String(i + 1)),
      h("span.rail-text", h("span.rail-title", st.title), h("span.rail-body", ...st.body)),
      crop,
    );
    item.addEventListener("click", () => choose(i));
    item.addEventListener("mouseenter", () => choose(i));
    item.addEventListener("focus", () => choose(i));
    item.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        choose((active + 1) % STEPS.length, true);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        choose((active + STEPS.length - 1) % STEPS.length, true);
      }
    });
    items.push(item);
    list.append(item);
  });
  choose(0);
  return h(
    "section.l-section",
    { id: "how" },
    h(
      "div.l-wrap",
      sectionHead("How it works", "Four steps, and no one holds the whole key", "Sealing happens in the bidder's browser. Everything after it happens on chain, where anyone can check it."),
      h("div.rail", list, h("figure.rail-figure", { id: "rail-figure" }, art)),
      h(
        "p.cap.rail-foot",
        "Every hash and envelope is bound to the chain id, the auction, the bidder and the bidder's own counter, so nothing can be replayed elsewhere. Figures in step 4 are the testnet demo run's. ",
        h("a", { href: `${REPO}#how-it-works`, ...ext }, "The full protocol"),
      ),
    ),
  );
}

// ---------------------------------------------------------------- security, on the dark band

function security(): HTMLElement {
  const line = (tag: "REFUSED" | "OPENED" | "CLEARED" | "EXCLUDED", what: string, why: string) =>
    h("div.t-line", h(`span.t-tag.t-${tag.toLowerCase()}`, tag), h("span.t-what", what), h("span.t-why", why));
  const terminal = h(
    "div.terminal",
    { role: "group", "aria-label": "Real results" },
    h("div.t-bar", h("i"), h("i"), h("i"), h("span", "evidence")),
    h(
      "div.t-body",
      h("div.t-comment", "# testnet, 16 Nov 2026, auction 0x9CbA…c124"),
      line("REFUSED", "a release signed by an outsider's ML-DSA-87 key", "ReleaseSignatureInvalid, live pqcVerify"),
      line("OPENED", "both bids with member 3 offline", "any 2 of 3 rebuild K"),
      line("CLEARED", "60 + 40 PEAL-T at 1.50 fUSD", "contract ends holding nothing"),
      h("div.t-comment", "# local, real keys: npm run e2e:local"),
      line("REFUSED", "a REST proxy swapping member 2's ML-KEM key", "hash signed on chain"),
      line("REFUSED", "finalize before the release deadline", "TooEarly"),
      line("EXCLUDED", "a junk bid", "its bond burns; the auction goes on"),
    ),
  );
  const yes = (t: string) => h("span.cmp-yes", icon("check"), t);
  const no = (t: string) => h("span.cmp-no", icon("cross"), t);
  const rows: [string, HTMLElement, HTMLElement][] = [
    ["Who can read a bid before the close", no("Whoever holds the auction key"), yes("No single party")],
    ["The key holder is away at the close", no("No bid opens"), yes("Any two of three open them")],
    ["Opening before the close", no("Possible, off chain"), yes("Refused: releases need the on-chain close")],
    ["Who checks the opener", no("Nobody"), yes("pqcVerify, on chain, every release")],
    ["A bid that cannot be opened", no("Stalls or voids the sale"), yes("Refunded; the auction goes on")],
  ];
  const table = h(
    "div.cmp",
    h(
      "table",
      h("thead", h("tr", h("th", h("span.sr-only", "Property")), h("th", "One auction key"), h("th", "Peal Sealed Auction"))),
      h("tbody", ...rows.map(([p, a, b]) => h("tr", h("th", { scope: "row" }, p), h("td", { "data-col": "One auction key" }, a), h("td", { "data-col": "Peal Sealed Auction" }, b)))),
    ),
  );
  return h(
    "section.l-section.l-dark",
    { id: "security" },
    h(
      "div.l-wrap",
      sectionHead(
        "Security",
        "One auction key is one point of failure",
        "The usual recipe seals every bid to a single auction key, so whoever holds it can read every bid before the close, or lose them all. Here there is no such key: a bid opens only when two of three members release, after the chain says bidding is over.",
      ),
      h("div.sec-grid", h("div", terminal, h("p.cap.t-src", "Sources: ", h("a", { href: DEMO_RUN, ...ext }, "every testnet transaction"), " · ", h("a", { href: `${BLOB}/scripts/e2e-local.ts`, ...ext }, "the local run"), " · ", h("a", { href: `${BLOB}/THREAT_MODEL.md`, ...ext }, "threat model"))), table),
    ),
  );
}

// ---------------------------------------------------------------- roles

function roleArt(kind: "issuer" | "bidder" | "member"): SVGSVGElement {
  const r = s("svg", { viewBox: "0 0 40 40", class: "role-art", "aria-hidden": "true", fill: "none", stroke: "#2563eb", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }) as SVGSVGElement;
  if (kind === "issuer") {
    r.append(s("path", { d: "M6 32h28M10 32V20M17 32V14M24 32V18M31 32V10" }), s("path", { d: "M8 12l9-6 7 5 9-6", stroke: "#93c5fd" }));
  } else if (kind === "bidder") {
    r.append(s("rect", { x: 5, y: 11, width: 30, height: 20, rx: 3 }), s("path", { d: "M6 12l14 10 14-10" }), s("rect", { x: 16.5, y: 18, width: 7, height: 7, rx: 1.5, fill: "#2563eb" }));
  } else {
    r.append(s("circle", { cx: 20, cy: 20, r: 14, stroke: "#93c5fd" }), s("circle", { cx: 20, cy: 8, r: 3.5, fill: "#2563eb" }), s("circle", { cx: 9.6, cy: 26, r: 3.5, fill: "#2563eb" }), s("circle", { cx: 30.4, cy: 26, r: 3.5, fill: "#fff" }));
  }
  return r;
}

function roles(): HTMLElement {
  const role = (kind: "issuer" | "bidder" | "member", title: string, body: string, link: string, href: string) =>
    h("div.role-card", roleArt(kind), h("h3", title), h("p", body), h("a.role-link", { href }, link, icon("arrow")));
  return h(
    "section.l-section.l-band",
    { id: "roles" },
    h(
      "div.l-wrap",
      sectionHead("Who uses it", "Three roles, each with its own keys"),
      h(
        "div.role-grid",
        role("issuer", "Issuers", "Open a sale or a treasury buyback. The whole supply is pulled at creation, and proceeds are exactly what winners pay.", "Open an auction", appHref("issuer")),
        role("bidder", "Bidders", "Check the committee's keys, seal a bid in the browser, and pay one clearing price, never more than your limit.", "Place a sealed bid", appHref("bidder", cfg?.demoAuction)),
        role("member", "Committee members", "Open your shares and sign one release, only after the close. Alone, a share says nothing about any bid.", "The committee page", appHref("committee")),
      ),
    ),
  );
}

// ---------------------------------------------------------------- try it

function tryIt(): HTMLElement {
  const grid = h("div.try-grid");
  const draw = () => {
    const g = wallet.guestStatus;
    const has = Boolean(g);
    const isFunded = g ? funded(g) : false;
    const pealt = guestPealt();
    const hasPealt = (pealt ?? 0n) > 0n;
    const done = (on: boolean) => (on ? chip("done", "ok") : null);
    const step = (n: number, title: string, body: Child, state: HTMLElement | null, ...cta: Child[]) =>
      h(`div.try-step${state ? ".is-done" : ""}`, h("div.try-top", h("span.rail-n", String(n)), state), h("h3", title), h("p", body), h("div.try-cta", ...cta));
    const create = h("button.btn.btn-primary", { type: "button", id: "try-create" }, icon("key"), has ? "Open your wallet" : "Create it");
    create.addEventListener("click", () => openPanel());
    const claim = h("button.btn", { type: "button", id: "try-pealt", disabled: !has || !isFunded || Boolean(wallet.busy) ? true : undefined }, "Claim 1,000 PEAL-T");
    claim.addEventListener("click", () => void claimPealt());
    grid.replaceChildren(
      step(1, "Make a guest account", "A fresh testnet account in your browser, with its own ML-DSA-87 key. Back it up or forget it any time.", done(has), create),
      step(
        2,
        "Fund it with test QOR",
        cfg?.network === "local" ? "On the local node, one click in the wallet adds 10 test QOR." : "Claim from the QoreChain faucet to your guest's qor1 address, or send from QoreX. About 1 QOR covers one bid; a whole first bid measured 0.51 QOR.",
        done(isFunded),
        cfg?.network === "local" ? null : h("a.btn", { href: FAUCET_URL, ...ext }, "Dashboard faucet", icon("out")),
      ),
      step(3, "Get test PEAL-T", "The demo auction sells fUSD for PEAL-T. The demo faucet gives each address 1,000 a day.", done(hasPealt), claim),
      step(
        4,
        "Seal and commit a bid",
        "Check the committee, choose a quantity and your price limit, and commit. After the close the committee releases and you see your bid opened.",
        null,
        h("a.btn.btn-primary", { href: appHref("bidder", cfg?.demoAuction), id: "try-bid" }, "Bid in the demo auction", icon("arrow")),
      ),
    );
  };
  subscribe(draw);
  draw();
  return h(
    "section.l-section",
    { id: "try" },
    h(
      "div.l-wrap",
      sectionHead("Try it", "Place a sealed bid in about five minutes", "On the QoreChain testnet, with test tokens. Your keys stay in this browser; the demo committee releases after the close."),
      grid,
      h("p.cap.try-foot", "Committee members and issuers use their own accounts and the CLI: ", h("span.mono", "npm run testnet -- settle 0x…"), ". ", h("a", { href: `${REPO}#try-it`, ...ext }, "Run it all locally")),
    ),
  );
}

// ---------------------------------------------------------------- family, footer

function familyBand(): HTMLElement {
  return h(
    "section.l-section.l-band.l-family",
    h(
      "div.l-wrap",
      sectionHead("The Peal family", "Three products, one set of keys and rules"),
      h(
        "div.family-grid",
        ...FAMILY.map((p) =>
          h(
            `a.family-card${p.id === "auction" ? ".is-current" : ""}`,
            p.id === "auction" ? { href: "#top" } : { href: p.href, ...ext },
            h("div.family-top", mark(p.id, "mark"), p.id === "auction" ? chip("You are here", "wait", "dot") : icon("out")),
            h("strong", p.name),
            h("span", p.line),
          ),
        ),
      ),
    ),
  );
}

function footer(): HTMLElement {
  const col = (title: string, ...links: [string, string, boolean?][]) =>
    h("div.foot-col", h("h4", title), ...links.map(([t, href, isExt]) => h("a", isExt ? { href, ...ext } : { href }, t)));
  return h(
    "footer.l-foot",
    h(
      "div.l-wrap",
      h(
        "div.foot-grid",
        h("div.foot-brand", h("a.wordmark", { href: "#top" }, mark("auction"), "Peal Sealed Auction"), h("p", "A uniform-price sealed-bid auction on QoreChain whose bids no single key holder can open before the close.")),
        col("Product", ["Auctions", appHref("auctions")], ["Place a bid", appHref("bidder", cfg?.demoAuction)], ["Results", appHref("results", cfg?.demoAuction)], ["Committee", appHref("committee")]),
        col("Developers", ["GitHub", REPO, true], ["Threat model", `${BLOB}/THREAT_MODEL.md`, true], ["Testnet findings", `${BLOB}/docs/spikes.md`, true], ["qore-pq-kit", "https://github.com/Adityaakr/qore-pq-kit", true]),
        col("Hackathon", ["QoreChain", "https://qorechain.io", true], ["Testnet faucet", FAUCET_URL, true], ["How AI built this", `${BLOB}/AI_USAGE.md`, true]),
      ),
      h("div.foot-base", h("span", "Apache-2.0 · Testnet only, not audited"), h("span", "Design language from Peal")),
    ),
  );
}

// ---------------------------------------------------------------- motion

function motion(): void {
  if (!window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches) return;
  document.documentElement.classList.add("motion");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { threshold: 0.15 },
  );
  document.querySelectorAll(".l-section, .hero-figure, .l-proof").forEach((el) => io.observe(el));
}

// ---------------------------------------------------------------- page

async function main(): Promise<void> {
  try {
    cfg = await loadConfig();
  } catch (e) {
    cfgError = e instanceof Error ? e.message : String(e);
  }
  if (cfg) startWallet(cfg);
  app.replaceChildren(nav(), h("main", hero(), proofBar(), stepRail(), security(), roles(), tryIt(), familyBand()), footer());
  motion();
  void fillProof();
}

void main();
