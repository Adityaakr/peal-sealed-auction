/**
 * The judge page (/judge): check and attack the deployed testnet contracts with no
 * wallet, no account and no funds. Live reads, and real `eth_call`s whose refusals are
 * decoded from the contract's own revert data (client/attempts.ts, client/judge.ts).
 *
 * The page holds no key and sends no transaction: everything it asks is an eth_call,
 * an eth_get* read or a REST read. It reads the testnet only, whatever `?net` says,
 * because it is about the deployed contracts. Each part loads, fails and retries on
 * its own, so one bad answer never blanks the page.
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { pealTAbi, sealedAuctionAbi } from "../../../client/abi.ts";
import { curlFor } from "../../../client/attempts.ts";
import { attempts, JUDGE, reason, runStep, type Attempt, type JudgeContext, type StepResult } from "../../../client/judge.ts";
import { auctionSummary, chainOf, loadConfig, STATE_WORDS, type AppConfig } from "./config.ts";
import { addressLink, configureExplorer, EXPLORER_NOTE, txHash } from "./explorer.ts";
import { amount, chip, duration, h, icon, mark, price2, type Child } from "./ui.ts";

const REPO = "https://github.com/Adityaakr/peal-sealed-auction";
const BLOB = `${REPO}/blob/main`;
const ext = { target: "_blank", rel: "noopener" };
const app = document.getElementById("app")!;
const n0 = (x: bigint | number) => x.toLocaleString("en-US");

// ------------------------------------------------------------------ small pieces

function head(index: string, title: Child, lead: Child): HTMLElement {
  return h("header.sa-head", h("div.sa-index", h("span", index)), h("div.sa-head-text", h("h2.sa-title", title), h("p.sa-lead", lead)));
}

function button(label: Child | Child[], cls: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h(`button.sa-btn${cls}`, { type: "button", ...attrs }, ...[label].flat()) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

/** A part of the page that loads by itself: skeleton, then content, or the reason and a retry. */
function loading(id: string, cls: string, what: string, load: () => Promise<Node[]>): HTMLElement {
  const host = h(`div.${cls}`, { id, "aria-busy": "true", "aria-live": "polite" });
  const run = async () => {
    host.setAttribute("aria-busy", "true");
    host.dataset.state = "loading";
    host.replaceChildren(h("div.jd-skel", h("span", `Reading ${what}…`)));
    try {
      const nodes = await load();
      host.replaceChildren(...nodes);
      host.dataset.state = "ready";
    } catch (err) {
      host.replaceChildren(failure(`Could not read ${what}.`, err, () => void run()));
      host.dataset.state = "failed";
    }
    host.setAttribute("aria-busy", "false");
  };
  retries.push(() => host.dataset.state === "failed" && void run());
  void run();
  return host;
}
const retries: (() => unknown)[] = [];

function failure(what: string, err: unknown, retry: () => void): HTMLElement {
  return h(
    "div.jd-fail",
    { role: "alert" },
    icon("cross"),
    h("div", h("strong", what), h("p", `${reason(err)} The page itself is fine: the public testnet RPC is a shared endpoint and may be busy. Nothing here counts as a refusal.`)),
    button("Retry", ".sa-btn-line.sa-btn-s", retry),
  );
}

const row = (label: string, value: Child) => h("div.jd-row", h("dt", label), h("dd", value));

// ------------------------------------------------------------------ navigation and guide

function nav(): HTMLElement {
  return h(
    "nav.sa-nav",
    { "aria-label": "Main" },
    h(
      "div.sa-wrap.sa-nav-in",
      h("a.sa-word", { href: "/" }, mark("auction", "sa-mark", "dark"), h("span", "Peal Sealed Auction")),
      h(
        "div.sa-links",
        ...[["#settled", "Settled auctions"], ["#attack", "Attack it"], ["#open", "Open auction"], ["#rubric", "Rubric"], ["#requirements", "Requirements"]].map(([href, t]) => h("a", { href }, t)),
        h("a", { href: REPO, ...ext }, "GitHub"),
      ),
      h("div.sa-nav-cta.jd-nav-cta", h("a.sa-btn.sa-btn-line.sa-btn-s", { href: "/" }, "The product")),
    ),
  );
}

function guide(ctx: JudgeContext | undefined): HTMLElement {
  const step = (href: string, title: string, body: string, time: string) =>
    h("li", h("a", { href }, h("span.jd-step-title", title), h("span.jd-step-time", time)), h("p", body));
  return h(
    "section.sa-hero.jd-hero",
    { id: "top" },
    h(
      "div.sa-wrap.sa-hero-grid",
      h(
        "div.sa-hero-copy",
        h("p.sa-tag", h("span.sa-dot", { "aria-hidden": "true" }), "For the jury · qorechain-diana"),
        h("h1.sa-display", "Attack it yourself. ", h("em", "Nothing to fund.")),
        h("p.sa-hero-lead", "No wallet, no account, no funds. Every button sends a real call to the deployed testnet contracts and shows the contract's own answer. Calls change nothing on chain."),
        h(
          "ol.jd-steps",
          step("#settled", "See two settled auctions", "Read live, and re-verified in your browser.", "30 s"),
          step("#attack", "Run the attacks", "Forged, early, replayed and edited releases, a bid to the wrong committee.", "1 min"),
          step("#rubric", "Match it to your rubric", "What each criterion can be checked against here, and what it cannot.", "1 min"),
        ),
      ),
      h(
        "div.sa-vault.jd-panel",
        h("div.sa-label", "Attack panel"),
        h("div.jd-tally", { id: "tally", role: "status", "aria-live": "polite" }, h("strong", "Not run yet"), h("span", "Eight groups of calls, about 10 seconds.")),
        ctx ? button([icon("arrow"), "Run every attack"], ".sa-btn-brass.jd-run-all", () => void runAll(), { id: "run-all" }) : null,
        h("div.jd-live", { id: "live" }),
        h("p.sa-source", "Is a call faked here? Every row has “copy as curl”: repeat it from your own terminal. All of them at once: ", h("code", "npm run judge:live"), "."),
      ),
    ),
  );
}

async function liveNodes(ctx: JudgeContext, cfg: AppConfig): Promise<Node[]> {
  const [id, block] = await Promise.all([ctx.client.getChainId(), ctx.client.getBlock()]);
  if (id !== cfg.chainId) throw new Error(`the RPC answers for chain ${id}, not ${cfg.chainId}`);
  const age = Math.max(0, Math.round(Date.now() / 1000 - Number(block.timestamp)));
  return [
    h("dl.jd-rows", row("Chain", `qorechain-diana, EVM ${id}`), row("Latest block", h("span", { id: "live-block" }, `${n0(block.number)} · ${duration(age)} ago`)), row("Registry", addressLink(ctx.registry, "CommitteeRegistry")), row("Factory", addressLink(ctx.factory, "SealedAuctionFactory"))),
  ];
}

// ------------------------------------------------------------------ 01 settled auctions

interface Token { decimals: number; symbol: string }

async function token(client: PublicClient, a: Address): Promise<Token> {
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: a, abi: pealTAbi, functionName: "decimals" }),
    client.readContract({ address: a, abi: pealTAbi, functionName: "symbol" }),
  ]);
  return { decimals: Number(decimals), symbol };
}

async function settledNodes(ctx: JudgeContext, auction: Address, releaseTxs: readonly Hex[], finalizeTx: Hex): Promise<Node[]> {
  const read = <T>(functionName: string, args: unknown[] = []) => ctx.client.readContract({ address: auction, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;
  const s = await auctionSummary(ctx.client, auction);
  const [sale, quote, price, sold, proceeds] = await Promise.all([token(ctx.client, s.cfg.saleToken), token(ctx.client, s.cfg.quoteToken), read<bigint>("clearingPrice"), read<bigint>("totalSold"), read<bigint>("grossProceeds")]);
  const bids = await Promise.all(Array.from({ length: s.bidCount }, (_, i) => read<{ quantity: bigint; tick: number; status: number }>("getBid", [BigInt(i)])));
  const released = s.members.filter((_, i) => (s.releaseMask >> i) & 1).length;
  const auditOut = h("div.jd-audit", { "aria-live": "polite" });
  const audit = button("Re-verify it in this browser", ".sa-btn-line.sa-btn-s.jd-audit-btn", () => void runAudit(), {});
  const runAudit = async () => {
    audit.disabled = true;
    auditOut.replaceChildren(h("p.jd-wait", "Verifying every ML-DSA-87 release and reopening every bid…"));
    try {
      const { auditAuction } = await import("../../../client/audit.ts");
      const r = await auditAuction(ctx.client, auction);
      const verified = r.releases.filter((x) => x.signatureOk === true);
      const reopened = r.bids.filter((b) => b.agrees === true);
      const unread = r.releases.filter((x, i) => ((s.releaseMask >> i) & 1) === 1 && x.signatureOk === undefined);
      auditOut.replaceChildren(
        h("p", unread.length && r.ok ? chip("partly verified", "warn") : r.ok ? chip("verified here", "ok") : chip("did not verify", "bad")),
        h("ul.jd-list", h("li", `${verified.length} of ${released} release signatures verified with @qorechain/pqc against the keys the chain registered`), h("li", `${reopened.length} of ${r.bids.length} bids reopened here agree with the contract`), ...unread.map((x) => h("li", `member ${x.memberIndex}: ${x.note ?? "not checkable"}`))),
      );
    } catch (err) {
      auditOut.replaceChildren(failure("Could not run the check.", err, () => void runAudit()));
    }
    audit.disabled = false;
  };
  return [
    h(
      "dl.jd-rows",
      row("State", s.state === "Settled" ? chip("settled", "ok") : chip(STATE_WORDS[s.state] ?? s.state, "wait")),
      row("Clearing price", h("span.jd-big", `${price2(price, quote.decimals)} ${quote.symbol}`, h("small", ` per ${sale.symbol}`))),
      row("Sold", `${amount(sold, sale.decimals)} of ${amount(s.cfg.totalSupply, sale.decimals)} ${sale.symbol} for ${amount(proceeds, quote.decimals)} ${quote.symbol}`),
      row("Released", `${released} of ${s.members.length} members (any ${s.threshold} open every bid)`),
      ...bids.map((b, i) => row(`Bid ${i}`, b.status === 1 ? `${amount(b.quantity, sale.decimals)} ${sale.symbol} at most ${price2(s.cfg.reservePrice + BigInt(b.tick) * s.cfg.tickSize, quote.decimals)} ${quote.symbol}` : b.status === 0 ? "sealed" : "not counted, refunded")),
      row("Contract", addressLink(auction, "auction")),
      row("Releases", h("span.jd-txs", ...releaseTxs.map((t, i) => h("span", txHash(t, `release ${i + 1}`))))),
      row("Finalized", txHash(finalizeTx, "finalize")),
    ),
    h("div.jd-actions", audit, h("a.sa-btn.sa-btn-line.sa-btn-s", { href: `/results.html?auction=${auction}` }, "Full results page")),
    auditOut,
  ];
}

function settled(ctx: JudgeContext): HTMLElement {
  const card = (id: string, title: string, sub: string, a: Address, rel: readonly Hex[], fin: Hex) =>
    h("article.jd-card", h("h3.jd-card-title", title), h("p.jd-card-sub", sub), loading(id, "jd-card-body", "this auction", () => settledNodes(ctx, a, rel, fin)));
  return h(
    "section.sa-section",
    { id: "settled" },
    h(
      "div.sa-wrap",
      head("01 · Settled auctions", "Two whole auctions, opened by the contract itself.", "Today's open auction settles only after judging, so these two come first. Everything below is read from the chain now."),
      h(
        "div.jd-cards",
        card("settled-first", "The 16 November run", "Two bids. Member 3 stayed offline, and two members were enough.", JUDGE.firstRun.auction, JUDGE.firstRun.releaseTxs, JUDGE.firstRun.finalizeTx),
        card("settled-demo", "The first open demo", "Three bids from guest accounts made on this site, settled on 23 November.", JUDGE.openDemo.auction, JUDGE.openDemo.releases.map((r) => r.tx), JUDGE.openDemo.finalizeTx),
      ),
      h("p.sa-source", EXPLORER_NOTE),
    ),
  );
}

// ------------------------------------------------------------------ 02 the attack panel

interface Card {
  attempt: Attempt;
  run: () => Promise<void>;
  results: StepResult[] | undefined;
  /** Could not even be prepared. */
  failed: boolean;
}
const cards: Card[] = [];

function resultChip(r: StepResult): HTMLElement {
  const v = r.verdict;
  if (v.kind === "not-run") return chip("could not run", "warn");
  if (r.step.role === "control") {
    if (v.kind !== "intended") return chip("control failed", "bad");
    const past = r.step.kind === "call" && "refused" in r.step.expect;
    return chip(past ? "gets past the check" : "works", "plain", "check");
  }
  if (r.step.role === "limit") return v.kind === "intended" ? chip("accepted, as stated", "warn", "dot") : chip("not as stated", "bad");
  if (v.kind === "intended") return chip(r.step.kind === "call" && "accepted" in r.step.expect ? "held" : "refused", "ok");
  return v.kind === "another-check" ? chip("another check answered", "warn") : chip("NOT refused", "bad");
}

function stepRow(ctx: JudgeContext, r: StepResult): HTMLElement {
  const s = r.step;
  const where = s.kind === "local" ? "checked in this browser" : `${s.call.to ? "eth_call" : "batched eth_call"} at ${s.call.block === undefined ? "the latest block" : `block ${n0(s.call.block)}`} · ${r.ms} ms`;
  const want = s.kind === "call" && "refused" in s.expect && r.verdict.kind === "another-check" ? h("p.jd-why", `This attempt is about ${s.expect.refused}.`) : null;
  const copy = s.kind === "call" ? (h("button.jd-copy", { type: "button" }, "copy as curl") as HTMLButtonElement) : null;
  copy?.addEventListener("click", () => {
    void navigator.clipboard?.writeText(curlFor(ctx.ep.url, (s as Extract<typeof s, { kind: "call" }>).call)).then(
      () => { copy.textContent = "copied"; setTimeout(() => (copy.textContent = "copy as curl"), 1400); },
      () => { copy.textContent = "copy blocked"; },
    );
  });
  return h(
    `li.jd-res.is-${s.role}`,
    { "data-step": s.id, "data-verdict": r.verdict.kind },
    h("div.jd-res-main", h("div.jd-res-label", h("span.jd-role", { attack: "attack", control: "control", limit: "known limit" }[s.role]), s.label), h("p.jd-why", s.why), want),
    h("div.jd-res-out", resultChip(r), h("code.jd-answer", r.said), h("div.jd-where", where, copy ? " · " : "", copy)),
  );
}

function attackCard(ctx: JudgeContext, a: Attempt): HTMLElement {
  const out = h("ol.jd-results", { "aria-live": "polite" });
  const btn = button("Run", ".sa-btn-line.sa-btn-s", () => void card.run(), { "aria-label": `Run: ${a.title}` });
  const el = h(
    "article.jd-attack",
    { id: `attempt-${a.id}`, "data-state": "idle" },
    h("div.jd-attack-top", h("div", h("h3.jd-card-title", a.title), h("p.jd-card-sub", a.question)), btn),
    out,
    ...a.limits.map((l) => h("p.jd-limit", l)),
  );
  const card: Card = {
    attempt: a,
    results: undefined,
    failed: false,
    run: async () => {
      if (el.dataset.state === "running") return;
      el.dataset.state = "running";
      btn.disabled = true;
      btn.textContent = "Running…";
      out.replaceChildren(h("li.jd-wait", "Asking the testnet…"));
      try {
        const steps = await a.steps();
        const results = await Promise.all(steps.map((s) => runStep(ctx, s)));
        card.results = results;
        card.failed = false;
        out.replaceChildren(...results.map((r) => stepRow(ctx, r)));
        el.dataset.state = results.some((r) => r.verdict.kind === "not-run") ? "partial" : results.every((r) => r.verdict.kind === "intended") ? "done" : "wrong";
      } catch (err) {
        card.results = undefined;
        card.failed = true;
        out.replaceChildren(h("li", failure("This attempt could not be prepared.", err, () => void card.run())));
        el.dataset.state = "failed";
      }
      btn.disabled = false;
      btn.textContent = el.dataset.state === "done" ? "Run again" : "Retry";
      tally();
    },
  };
  cards.push(card);
  return el;
}

function tally(): void {
  const all = cards.flatMap((c) => c.results ?? []);
  const ran = cards.filter((c) => c.results).length;
  const failed = cards.filter((c) => c.failed).length;
  const of = (role: string) => all.filter((r) => r.step.role === role);
  const good = (rs: StepResult[]) => rs.filter((r) => r.verdict.kind === "intended").length;
  const attacks = of("attack");
  const wrong = all.filter((r) => !["intended", "not-run"].includes(r.verdict.kind)).length;
  const notRun = all.filter((r) => r.verdict.kind === "not-run").length;
  const clean = ran === cards.length && !wrong && !notRun;
  document.getElementById("tally")!.replaceChildren(
    h(`strong${clean ? ".is-ok" : wrong ? ".is-bad" : ""}`, `${good(attacks)} of ${attacks.length} attacks stopped`),
    h("span", `by the check each was aimed at · ${good(of("control"))} of ${of("control").length} controls work · ${ran} of ${cards.length} groups run`),
    ...(wrong ? [h("span.is-bad", `${wrong} answers were not the expected ones`)] : []),
    ...(notRun || failed ? [h("span.is-warn", `${notRun ? `${notRun} calls could not run` : ""}${notRun && failed ? ", " : ""}${failed ? `${failed} groups could not be prepared` : ""}: retry below`)] : []),
  );
}

async function runAll(): Promise<void> {
  const b = document.getElementById("run-all") as HTMLButtonElement;
  b.disabled = true;
  document.getElementById("attack")?.setAttribute("aria-busy", "true");
  for (const [i, c] of cards.entries()) {
    b.replaceChildren(`Running ${i + 1} of ${cards.length}…`);
    await c.run();
  }
  document.getElementById("attack")?.setAttribute("aria-busy", "false");
  b.disabled = false;
  b.replaceChildren(icon("arrow"), "Run them again");
}

function attackPanel(ctx: JudgeContext): HTMLElement {
  return h(
    "section.sa-section",
    { id: "attack" },
    h(
      "div.sa-wrap",
      head(
        "02 · Attack it",
        "Real calls, each aimed at one check.",
        h("span", "Both demos are settled, so a forged release sent today would stop at “already settled” and prove nothing. The release attacks run at the older block where the first open demo was really waiting for releases, and start from the genuine release the contract accepted there. Error names come from the contract's revert data. A refusal by any other check is marked as such, and a call that could not run is never counted as refused."),
      ),
      h("div.jd-attacks", ...attempts(ctx).map((a) => attackCard(ctx, a))),
      h("p.sa-source", "Building a page like this? ", h("a", { href: `${BLOB}/client/attempts.ts`, ...ext }, "client/attempts.ts"), " is one self-contained file that needs only viem. These attempts are in ", h("a", { href: `${BLOB}/client/judge.ts`, ...ext }, "client/judge.ts"), "."),
    ),
  );
}

// ------------------------------------------------------------------ 03 the open auction and its committee

async function openNodes(ctx: JudgeContext): Promise<Node[]> {
  const auction = ctx.openAuction;
  const [s, block] = await Promise.all([auctionSummary(ctx.client, auction), ctx.client.getBlock()]);
  const bids = await Promise.all(Array.from({ length: s.bidCount }, (_, i) => ctx.client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "getBid", args: [BigInt(i)] })));
  const sealed = bids.filter((b) => b.status === 0);
  return [
    h(
      "dl.jd-rows",
      row("State", s.state === "CommitOpen" && block.timestamp < s.cfg.endTime ? chip(`open, ${duration(s.cfg.endTime - block.timestamp)} left`, "wait") : chip(STATE_WORDS[s.state] ?? s.state, s.state === "Settled" ? "ok" : "plain")),
      row("Bidding closes", `${new Date(Number(s.cfg.endTime) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`),
      row("Bids", `${s.bidCount} of ${s.cfg.maxBids}, ${sealed.length} sealed`),
      row("Contract", addressLink(auction, "open auction")),
    ),
    h("ul.jd-cts", ...bids.map((b, i) => h("li", h("span.jd-role", `bid ${i}`), h("code", { title: b.ct }, b.ct.slice(0, 26) + "…"), h("span.sa-muted", b.status === 0 ? `quantity ${b.quantity}, unreadable` : "opened")))),
    h("p.jd-why", "A sealed bid's stored quantity is 0 until openBids decrypts it. The contract also holds the bidder, the hashes and the escrow; the escrow is public and bounds the bid."),
  ];
}

async function committeeNodes(ctx: JudgeContext): Promise<Node[]> {
  const [{ checkCommittee }, cards0] = await Promise.all([import("../../../client/committee.ts"), ctx.cards()]);
  const { committee } = await checkCommittee(ctx.client, ctx.registry, ctx.committeeSetId, { rest: ctx.rest, bundled: cards0 });
  return [
    h("p", chip(`${committee.members.length} of ${committee.members.length} members verified here`, "ok")),
    h("ul.jd-members", ...committee.members.map((m) => h("li", h("div.jd-res-label", `Member ${m.index}`), addressLink(m.address, `member ${m.index}`), h("p.jd-why", "ML-DSA-87 key registered with proof of possession (pqcKeyStatus). ML-KEM-1024 key from the chain's registry, SHA3-256 equal to ", h("code", `${m.kemKeySha3.slice(0, 10)}…`), ", which this member signed on chain. Recipient card matches both.")))),
    h("p.jd-limit", "One owner holds all three of these keys in this demo. The check proves which keys a bid is sealed to, not that three people hold them."),
  ];
}

function openAuction(ctx: JudgeContext): HTMLElement {
  return h(
    "section.sa-section",
    { id: "open" },
    h(
      "div.sa-wrap",
      head("03 · Today's open auction", "Open, and sealed through judging.", h("span", "Placing a bid of your own is the one thing here that needs test funds (about 1 test QOR): ", h("a", { href: "/#try" }, "try it with a guest account"), ". Attempt “A bid to the wrong committee” above seals a real bid in this browser and plays its commit without any.")),
      h(
        "div.jd-cards",
        h("article.jd-card", h("h3.jd-card-title", "The sealed bids"), h("p.jd-card-sub", "Read from the contract now."), loading("open-live", "jd-card-body", "the open auction", () => openNodes(ctx))),
        h("article.jd-card", h("h3.jd-card-title", "Who they are sealed to"), h("p.jd-card-sub", "The check a bidder's browser makes before sealing, run now in yours."), loading("committee-live", "jd-card-body", "the committee's keys", () => committeeNodes(ctx))),
      ),
    ),
  );
}

// ------------------------------------------------------------------ 04, 05 the rubric and the requirements

const doc = (path: string, label: string) => h("a", { href: `${BLOB}/${path}`, ...ext }, label);
const here = (href: string, label: string) => h("a", { href }, label);

function table(name: string, cols: string[], rows: Child[][]): HTMLElement {
  return h(
    "div.jd-table",
    { role: "table", "aria-label": name },
    h("div.jd-tr.jd-th", { role: "row" }, ...cols.map((c) => h("div", { role: "columnheader" }, c))),
    ...rows.map((r) => h("div.jd-tr", { role: "row" }, ...r.map((c, i) => h("div", { role: "cell", "data-col": cols[i] }, c)))),
  );
}

function rubric(): HTMLElement {
  return h(
    "section.sa-section",
    { id: "rubric" },
    h(
      "div.sa-wrap",
      head("04 · The rubric", "What each criterion can be checked against, and what it cannot.", "The points are the fest's. The scores are yours."),
      table("Rubric", ["Criterion", "Check it here", "What this page does not show"], [
        [h("span", h("strong", "Works as described"), h("small", "25 points")), h("span", here("#settled", "Two settled auctions"), ", re-verified in your browser; the genuine release accepted (", here("#attempt-control", "control"), "); two releases opening a bid (", here("#attempt-one-key", "one member alone"), ")."), "A bid of your own costs about 0.4 test QOR and an account. Today's auction opens after judging."],
        [h("span", h("strong", "QoreChain technology, verified"), h("small", "25 points")), h("span", "pqcVerify and pqcKeyStatus answer live in ", here("#attempt-forged", "every release attack"), " and ", here("#attempt-now", "at the latest block"), "; the ML-KEM key registry and QoreSeal in ", here("#committee-live", "the committee check"), ". Every kit and feature: ", doc("docs/kits.md", "docs/kits.md"), "."), "EVM windows and hybrid transactions need signed transactions, so they are evidence only: npm run evidence re-checks each recorded one. Kits left out are listed with the reason."],
        [h("span", h("strong", "Post-quantum correctness and security"), h("small", "20 points")), h("span", here("#attempt-forged", "Forged"), ", ", here("#attempt-early", "early"), ", ", here("#attempt-replayed", "replayed"), " and ", here("#attempt-edited", "edited"), " releases; ", doc("docs/PQC.md", "docs/PQC.md"), ", ", doc("THREAT_MODEL.md", "threat model"), "."), "Not independently audited. Escrow is public and bounds a bid. Two colluding members could read bids early, and one owner holds all three demo keys."],
        [h("span", h("strong", "Originality"), h("small", "15 points")), h("span", "The contract itself checks the ML-DSA-87 releases, rebuilds each bid's key and decrypts it: ", here("#attempt-one-key", "one release leaves a bid sealed, two open it"), "."), h("span", "Splitting a key 2-of-3 is not new by itself. What came from the author's earlier project is listed under ", doc("README.md#prior-work", "prior work"), ".")],
        [h("span", h("strong", "Clarity, UX and documentation"), h("small", "15 points")), h("span", "This page; ", here("/", "the product page"), "'s six diagrams; ", doc("README.md", "README"), "; ", doc("docs/DEMO.md", "docs/DEMO.md"), "."), "The explorer opens on mainnet and needs one press on Testnet. Committee and issuer roles need the CLI or their own keys."],
      ]),
    ),
  );
}

function requirements(): HTMLElement {
  return h(
    "section.sa-section",
    { id: "requirements" },
    h(
      "div.sa-wrap",
      head("05 · Encrypted Apps", "The category's four requirements.", "Each with a live check on this page."),
      table("Category requirements", ["Requirement", "Check it here", "What this page does not show"], [
        [h("strong", "ML-KEM-1024 encryption"), h("span", here("#attempt-committee", "A bid to the wrong committee"), " seals a bid in your browser: three QoreSeal envelopes (ML-KEM-1024 + X25519), one per member, and the contract accepts the commit."), "The contract does not look inside envelopes; the known limit in the same group shows it."],
        [h("strong", "Registered recipient keys"), h("span", here("#committee-live", "The committee check"), " reads each member's ML-KEM key from the chain's registry and compares it with the hash the member signed on chain."), "Registering a key needs a transaction: the three are in the README."],
        [h("strong", "ML-DSA key binding"), h("span", here("#attempt-committee", "Swapping one member's encryption key"), " fails with JoinSignatureInvalid; the genuine registration at the same block is accepted."), h("span", "The joins as they landed are in the registerSet transaction. The same check on releases is in ", here("#attempt-forged", "the forged release"), ".")],
        [h("strong", "Client-side encryption and decryption"), h("span", "Encryption runs in this tab. After the close, ", here("#settled", "re-verifying"), " reopens every bid in this tab from the released shares."), h("span", "A member's own decryption needs its secret key, so it is not on this page: it runs in ", here("/committee.html", "the member's browser"), " or daemon, and npm run web:smoke drives it in CI.")],
      ]),
    ),
  );
}

function footer(): HTMLElement {
  return h("footer.sa-foot.jd-foot", h("div.sa-wrap", h("div.sa-foot-base", h("span", "Apache-2.0 · testnet only, not audited · no key on this page, no transaction sent"), h("span", h("a", { href: "/" }, "Peal Sealed Auction"), " · ", h("a", { href: REPO, ...ext }, "Source")))));
}

// ------------------------------------------------------------------ page

function contextOf(cfg: AppConfig): JudgeContext {
  if (!cfg.demoAuction || !cfg.faucet || !cfg.committeeSetId) throw new Error("the testnet configuration is incomplete");
  return {
    ep: { url: cfg.evmRpc, retries: 3 },
    client: createPublicClient({ chain: chainOf(cfg), transport: http(cfg.evmRpc, { timeout: 15_000, retryCount: 4, retryDelay: 400 }) }) as PublicClient,
    rest: cfg.rest,
    registry: cfg.registry,
    factory: cfg.factory,
    pealt: cfg.pealt,
    faucet: cfg.faucet,
    committeeSetId: cfg.committeeSetId,
    openAuction: cfg.demoAuction,
    cards: async () => {
      const res = await fetch("/committee-cards.testnet.json");
      if (!res.ok) throw new Error(`the committee's cards did not load (HTTP ${res.status})`);
      return res.json();
    },
  };
}

async function main(): Promise<void> {
  let cfg: AppConfig;
  let ctx: JudgeContext;
  try {
    cfg = await loadConfig("testnet");
    ctx = contextOf(cfg);
  } catch (err) {
    app.replaceChildren(nav(), h("main.jd-main", guide(undefined), h("div.sa-wrap", failure("This page's configuration did not load.", err, () => location.reload())), rubric(), requirements()), footer());
    return;
  }
  configureExplorer(cfg.rest);
  app.replaceChildren(nav(), h("main.jd-main", guide(ctx), settled(ctx), attackPanel(ctx), openAuction(ctx), rubric(), requirements()), footer());
  document.getElementById("live")!.replaceWith(loading("live", "jd-live", "the testnet", () => liveNodes(ctx, cfg)));
  // The sections did not exist when the browser looked for the link's target.
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  window.addEventListener("online", () => retries.forEach((r) => r()));
}

void main();
