/**
 * Issuer page: create, fund and open an auction in one factory call.
 *
 * Selling PEAL-T for fUSD is an ordinary sale. Selling fUSD for PEAL-T is the
 * treasury's buyback (design decision D2): a bid of "at most X PEAL-T per fUSD"
 * is an offer of PEAL-T at "at least 1/X fUSD each", so the same forward
 * auction clears a buyback at one uniform price.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { pealTAbi, sealedAuctionFactoryAbi } from "../../../client/abi.ts";
import { $, accountPicker, activityCard, el, guard, header, loadConfig, logLine, pageHead, publicClientOf, send, type DevAccount } from "./common.ts";

const cfg = await loadConfig();
header("Open an auction", cfg);
const client = publicClientOf(cfg);
const app = $("#app");
app.replaceChildren(
  pageHead(
    "Issue",
    "Open an auction",
    "Creates, funds and opens the auction in one transaction; the whole supply is pulled at creation. The committee is the registered 2-of-3 set. A sale sells PEAL-T for fUSD; a buyback sells fUSD for PEAL-T.",
  ),
);

let me: DevAccount | undefined;
accountPicker(cfg, app, (a) => (me = a.kind === "dev" ? a.dev : undefined), { role: "the issuer" });

const field = (id: string, label: string, value: string, type = "text") =>
  el("label", { class: "field" }, el("span", {}, label), el("input", { id, type, value, class: "input" }));
const kind = el("select", { id: "kind", class: "input" }) as HTMLSelectElement;
kind.append(el("option", { value: "sale" }, "Sale: PEAL-T for fUSD"), el("option", { value: "buyback" }, "Buyback (D2): fUSD for PEAL-T"));
const form = el("div", { class: "card" }, el("h2", {}, "Terms"));
const grid = el(
  "div",
  { class: "form-grid" },
  el("label", { class: "field wide" }, el("span", {}, "Kind"), kind),
  field("supply", "Supply (whole tokens)", "100", "number"),
  field("reserve", "Reserve price (quote per sale token)", "1", "number"),
  field("step", "Tick size", "0.5", "number"),
  field("ticks", "Number of ticks (1 to 256)", "8", "number"),
  field("commit", "Bidding minutes", "10", "number"),
  field("release", "Release window minutes", "10", "number"),
  field("bond", "Bid bond (quote tokens)", "1", "number"),
  field("name", "Name", "Peal sealed sale"),
  field("details", "Details", "Uniform price, 2-of-3 committee"),
);
const go = el("button", { id: "create" }, "Create, fund and open") as HTMLButtonElement;
const out = el("div", { id: "created", class: "mono" });
form.append(grid, el("div", { class: "row", style: "margin-top:16px" }, go), out);
app.append(form, activityCard());

const v = (id: string) => ($(`#${id}`) as HTMLInputElement).value;
const decimals = async (t: Address) => Number(await client.readContract({ address: t, abi: pealTAbi, functionName: "decimals" }));

go.onclick = () =>
  guard(go, async () => {
    if (!me) throw new Error("choose an account first");
    if (!cfg.committeeSetId) throw new Error("this network's config has no committee set id");
    const [sale, quote] = kind.value === "buyback" ? [cfg.fusd, cfg.pealt] : [cfg.pealt, cfg.fusd];
    const [sd, qd] = await Promise.all([decimals(sale), decimals(quote)]);
    const now = (await client.getBlock()).timestamp;
    const commit = BigInt(Math.round(Number(v("commit")) * 60));
    const name = v("name");
    const details = v("details");
    const c = {
      issuer: me.address,
      saleToken: sale,
      quoteToken: quote,
      totalSupply: parseUnits(v("supply"), sd),
      saleDecimals: sd,
      reservePrice: parseUnits(v("reserve"), qd),
      tickSize: parseUnits(v("step"), qd),
      numTicks: Number(v("ticks")),
      startTime: now,
      endTime: now + commit,
      releaseDeadline: now + commit + BigInt(Math.round(Number(v("release")) * 60)),
      minBidQuantity: 1n,
      maxQuantityPerAddress: 0n,
      maxBids: 64,
      bidBond: parseUnits(v("bond"), qd),
      protocolFeeBps: 0,
      feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
      committeeSetId: cfg.committeeSetId,
      metadataHash: (await client.readContract({ address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "metadataHash", args: [name, details] })) as Hex,
    };
    await send(cfg, me, { to: sale, data: encodeFunctionData({ abi: pealTAbi, functionName: "approve", args: [cfg.factory, c.totalSupply] }) });
    const sim = await client.simulateContract({ account: me.address, address: cfg.factory, abi: sealedAuctionFactoryAbi, functionName: "createAuction", args: [c, name, details] });
    const hash = await send(cfg, me, { to: cfg.factory, data: encodeFunctionData({ abi: sealedAuctionFactoryAbi, functionName: "createAuction", args: [c, name, details] }) });
    const auction = sim.result as Address;
    const q = new URLSearchParams(location.search);
    q.set("auction", auction);
    out.replaceChildren(
      el("div", {}, `auction ${auction}`),
      el("div", { class: "row" }, el("a", { href: `./bidder.html?${q}` }, "bid"), el("a", { href: `./committee.html?${q}` }, "committee"), el("a", { href: `./results.html?${q}` }, "results")),
    );
    logLine(`${kind.value} auction ${auction} created, funded and open, tx ${hash}`, "ok");
  });
