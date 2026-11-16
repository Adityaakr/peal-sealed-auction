/**
 * Bidder page. Sealing runs entirely in this browser: the bid is encrypted under
 * a fresh key, the key is split 2-of-3, and each share is sealed with QoreSeal
 * (ML-KEM-1024 + X25519) to a committee member whose keys were first checked
 * against what the member signed on chain.
 */
import { encodeFunctionData, hexToBytes, parseUnits, type Address } from "viem";
import { pealTAbi, sealedAuctionAbi } from "../../../client/abi.ts";
import { bidContext, sealBid } from "../../../client/bid.ts";
import { readCommittee, resolveCommittee } from "../../../client/committee.ts";
import type { SealRecipient } from "@qorechain/qoreseal";
import { $, accountPicker, auctionSummary, el, fmt, guard, header, loadConfig, logLine, publicClientOf, send, short, type DevAccount } from "./common.ts";

const cfg = await loadConfig();
header("Place a sealed bid", cfg);
const client = publicClientOf(cfg);
const app = $("#app");
if (!cfg.auction) {
  app.replaceChildren(el("div", { class: "card" }, "No auction selected: open one from the home page."));
  throw new Error("no auction");
}
const auction = cfg.auction;
const s = await auctionSummary(client, auction);
const dec = async (t: Address) => Number(await client.readContract({ address: t, abi: pealTAbi, functionName: "decimals" }));
const sym = async (t: Address) => client.readContract({ address: t, abi: pealTAbi, functionName: "symbol" });
const [saleDec, quoteDec, saleSym, quoteSym] = await Promise.all([dec(s.cfg.saleToken), dec(s.cfg.quoteToken), sym(s.cfg.saleToken), sym(s.cfg.quoteToken)]);

app.replaceChildren();
const info = el("div", { class: "card" }, el("h1", {}, "Place a sealed bid"));
const kv = el("div", { class: "kv" });
const add = (k: string, v: string) => kv.append(el("div", {}, k), el("div", { class: "mono" }, v));
add("auction", auction);
add("state", s.state);
add("selling", `${fmt(s.cfg.totalSupply, saleDec)} ${saleSym} for ${quoteSym}`);
add("bidding closes", new Date(Number(s.cfg.endTime) * 1000).toLocaleString());
add("committee", `${s.threshold} of ${s.members.length}`);
add("bond", `${fmt(s.cfg.bidBond, quoteDec)} ${quoteSym} (refunded unless the bid is junk)`);
info.append(kv);
app.append(info);

let account: DevAccount | undefined;
accountPicker(cfg, app, (d) => (account = d));

// Committee check.
let recipients: SealRecipient[] | undefined;
const comm = el("div", { class: "card" }, el("h2", {}, "1. Check the committee"));
const commBtn = el("button", { id: "check-committee" }, "Check every member's keys") as HTMLButtonElement;
const commOut = el("div", { id: "committee" });
comm.append(
  el("p", { class: "muted" }, "For each member: the ML-DSA-87 key from the chain, the ML-KEM-1024 key from REST against the hash the member signed, and the QoreSeal card against both keys. A lying REST proxy cannot substitute a key."),
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
      ...c.members.map((m) => el("div", { class: "ok mono" }, `✓ member ${m.index} ${m.address} · ML-KEM sha3 ${short(m.kemKeySha3, 6)}`)),
    );
    logLine(`committee ${short(c.setId, 6)}: all ${c.members.length} members verified`, "ok");
  });

// Bid form.
const form = el("div", { class: "card" }, el("h2", {}, "2. Seal and commit"));
const qty = el("input", { id: "qty", type: "number", min: "0", step: "any", placeholder: `quantity of ${saleSym}` }) as HTMLInputElement;
const tick = el("select", { id: "tick" }) as HTMLSelectElement;
for (let t = 0; t < s.cfg.numTicks; t++) {
  const p = s.cfg.reservePrice + BigInt(t) * s.cfg.tickSize;
  const inv = p === 0n ? "∞" : (Number(10n ** BigInt(quoteDec)) / Number(p)).toPrecision(4);
  tick.append(el("option", { value: String(t) }, `tick ${t}: at most ${fmt(p, quoteDec)} ${quoteSym} per ${saleSym} (≥ ${inv} ${saleSym} per ${quoteSym})`));
}
const sealBtn = el("button", { id: "seal-commit" }, "Seal in this browser and commit") as HTMLButtonElement;
const out = el("div", { id: "sealed", class: "kv" });
form.append(el("div", { class: "row" }, qty, tick, sealBtn), out);
app.append(form);
sealBtn.onclick = () =>
  guard(sealBtn, async () => {
    if (!account) throw new Error("choose an account first");
    if (!recipients) throw new Error("check the committee first");
    const quantity = parseUnits(qty.value || "0", saleDec);
    const t = Number(tick.value);
    const ctx = await bidContext(client, auction, account.address, quantity, t);
    const need = ctx.escrow + ctx.bond;
    const bal = await client.readContract({ address: s.cfg.quoteToken, abi: pealTAbi, functionName: "balanceOf", args: [account.address] });
    if (bal < need) throw new Error(`needs ${fmt(need, quoteDec)} ${quoteSym} (escrow + bond); balance ${fmt(bal, quoteDec)}`);
    const t0 = performance.now();
    const c = sealBid({ chainId: BigInt(cfg.chainId), auction, bidder: account.address, seq: ctx.seq, quantity, tick: t, recipients, threshold: s.threshold });
    const ms = Math.round(performance.now() - t0);
    out.replaceChildren();
    const show = (k: string, v: string) => out.append(el("div", {}, k), el("div", { class: "mono" }, v));
    show("ciphertext", c.ct);
    show("key hash", c.keyHash);
    c.shareHashes.forEach((h, i) => show(`share ${i + 1} hash`, h));
    c.envelopes.forEach((e, i) => show(`envelope → member ${i + 1}`, `${hexToBytes(e).length} bytes, ${short(e, 12)}`));
    show("sealed in", `${ms} ms, in this browser`);
    logLine(`sealed bid #${ctx.seq} in ${ms} ms; plaintext never left this tab`, "ok");
    await send(cfg, account, { to: s.cfg.quoteToken, data: encodeFunctionData({ abi: pealTAbi, functionName: "approve", args: [auction, need] }) });
    const hash = await send(cfg, account, {
      to: auction,
      data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "commitBid", args: [c.seq, c.ct, c.keyHash, c.shareHashes, c.envelopes, ctx.escrow] }),
    });
    show("commit tx", hash);
    logLine(`bid committed: escrow ${fmt(ctx.escrow, quoteDec)} + bond ${fmt(ctx.bond, quoteDec)} ${quoteSym}, tx ${short(hash)}`, "ok");
  });

app.append(el("div", { class: "card" }, el("h2", {}, "Activity"), el("div", { id: "log" })));
