/**
 * Results page: state, releases, bids as the contract opened them, the clearing
 * price, and the permissionless steps (open, finalize, claims) anyone can call.
 */
import { createTestClient, encodeFunctionData, http, type Address } from "viem";
import { pealTAbi, sealedAuctionAbi } from "../../../client/abi.ts";
import { $, accountPicker, auctionSummary, chainOf, el, fmt, guard, header, loadConfig, logLine, publicClientOf, send, short, type DevAccount } from "./common.ts";

const cfg = await loadConfig();
header("Auction results", cfg);
const client = publicClientOf(cfg);
const app = $("#app");
if (!cfg.auction) {
  app.replaceChildren(el("div", { class: "card" }, "No auction selected: open one from the home page."));
  throw new Error("no auction");
}
const auction = cfg.auction;
const read = <T>(functionName: string, args: unknown[] = []) =>
  client.readContract({ address: auction, abi: sealedAuctionAbi, functionName, args } as never) as Promise<T>;
const STATUS = ["pending", "opened", "excluded", "unopenable"];
const EXCL = ["", "malformed", "below minimum", "over address cap", "escrow short", "no key", "no key after all releases"];

const summaryCard = el("div", { class: "card", id: "summary" });
const bidsCard = el("div", { class: "card" }, el("h2", {}, "Bids"), el("div", { class: "tablewrap", id: "bids" }));
app.replaceChildren(summaryCard, bidsCard);

let actor: DevAccount | undefined;
accountPicker(cfg, app, (d) => (actor = d));
const actions = el("div", { class: "card" }, el("h2", {}, "Permissionless steps"), el("p", { class: "muted" }, "Anyone may run these; funds always go to the bidder or the issuer."));
const btn = (id: string, label: string) => el("button", { id }, label) as HTMLButtonElement;
const bClose = btn("close", "Close bidding");
const bOpen = btn("open-bids", "Open all bids");
const bFinal = btn("finalize", "Finalize");
const bClaim = btn("claim-all", "Pay out every bid and the issuer");
const row = el("div", { class: "row" }, bClose, bOpen, bFinal, bClaim);
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
app.append(actions, el("div", { class: "card" }, el("h2", {}, "Activity"), el("div", { id: "log" })));

const tx = (b: HTMLButtonElement, what: string, data: () => Promise<`0x${string}`>) =>
  (b.onclick = () =>
    guard(b, async () => {
      if (!actor) throw new Error("choose an account first");
      const h = await send(cfg, actor, { to: auction, data: await data() });
      logLine(`${what}: tx ${short(h)}`, "ok");
      await render();
    }));
tx(bClose, "bidding closed", async () => encodeFunctionData({ abi: sealedAuctionAbi, functionName: "closeCommit" }));
tx(bOpen, "bids opened", async () => {
  const n = await read<number>("bidCount");
  return encodeFunctionData({ abi: sealedAuctionAbi, functionName: "openBids", args: [Array.from({ length: Number(n) }, (_, i) => BigInt(i))] });
});
tx(bFinal, "finalized", async () => encodeFunctionData({ abi: sealedAuctionAbi, functionName: "finalize" }));
bClaim.onclick = () =>
  guard(bClaim, async () => {
    if (!actor) throw new Error("choose an account first");
    const n = Number(await read<number>("bidCount"));
    const state = Number(await read<number>("state"));
    for (let i = 0; i < n; i++) {
      const b = await read<{ claimed: boolean }>("getBid", [BigInt(i)]);
      if (!b.claimed) await send(cfg, actor, { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "claim", args: [BigInt(i)] }) });
    }
    if (state === 4 && !(await read<boolean>("proceedsClaimed")))
      await send(cfg, actor, { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "claimProceeds" }) });
    if ((state === 4 || state === 5) && !(await read<boolean>("unsoldClaimed")))
      await send(cfg, actor, { to: auction, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "claimUnsold" }) });
    logLine("every bid and the issuer paid out", "ok");
    await render();
  });

async function render(): Promise<void> {
  const s = await auctionSummary(client, auction);
  const dec = async (t: Address) => Number(await client.readContract({ address: t, abi: pealTAbi, functionName: "decimals" }));
  const sym = (t: Address) => client.readContract({ address: t, abi: pealTAbi, functionName: "symbol" });
  const [sd, qd, ss, qs] = await Promise.all([dec(s.cfg.saleToken), dec(s.cfg.quoteToken), sym(s.cfg.saleToken), sym(s.cfg.quoteToken)]);
  const kv = el("div", { class: "kv" });
  const add = (k: string, v: string, id?: string) => kv.append(el("div", {}, k), el("div", { class: "mono", ...(id ? { id } : {}) }, v));
  add("auction", auction);
  add("state", s.state, "state");
  add("releases", s.members.map((m, i) => `${i + 1}:${(s.releaseMask >> i) & 1 ? "✓" : "–"}`).join("  ") + `  (need ${s.threshold})`, "releases");
  if (s.state === "Settled") {
    const [price, sold, proceeds] = await Promise.all([read<bigint>("clearingPrice"), read<bigint>("totalSold"), read<bigint>("grossProceeds")]);
    add("clearing price", `${fmt(price, qd)} ${qs} per ${ss}`, "price");
    add("sold", `${fmt(sold, sd)} ${ss}`);
    add("proceeds", `${fmt(proceeds, qd)} ${qs}`);
  }
  type B = { bidder: Address; ct: `0x${string}`; status: number; exclusion: number; quantity: bigint; tick: number; escrow: bigint; bondBurned: boolean; claimed: boolean };
  const ids = Array.from({ length: s.bidCount }, (_, i) => BigInt(i));
  const [bids, allocs] = await Promise.all([
    Promise.all(ids.map((i) => read<B>("getBid", [i]))),
    Promise.all(ids.map((i) => (s.state === "Settled" ? read<bigint>("allocationOf", [i]) : Promise.resolve(0n)))),
  ]);
  const rows = bids.map((b, i) => {
    const openedBid = b.status === 1 || b.status === 2;
    return el(
      "tr",
      {},
      el("td", {}, String(i)),
      el("td", { class: "mono" }, short(b.bidder, 6)),
      el("td", { class: b.status === 1 ? "ok" : b.status >= 2 ? "bad" : "" }, STATUS[b.status]! + (b.exclusion ? ` (${EXCL[b.exclusion]})` : "") + (b.bondBurned ? ", bond burned" : "")),
      el("td", { class: "mono" }, openedBid ? `${fmt(b.quantity, sd)} @ tick ${b.tick}` : `sealed ${short(b.ct, 6)}`),
      el("td", { class: "mono" }, fmt(b.escrow, qd)),
      el("td", { class: "mono" }, s.state === "Settled" ? fmt(allocs[i]!, sd) : "–"),
      el("td", {}, b.claimed ? "paid" : ""),
    );
  });
  summaryCard.replaceChildren(el("h1", {}, "Auction results"), kv);
  $("#bids").replaceChildren(
    el("table", {}, el("tr", {}, ...["bid", "bidder", "status", "opened to", "escrow", "allocation", ""].map((h) => el("th", {}, h))), ...rows),
  );
}

await render();
