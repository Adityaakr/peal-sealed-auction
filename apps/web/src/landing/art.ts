/**
 * art.ts - the landing page's schematics, drawn with the real names and sizes.
 *
 * Peal Sealed Auction's own look (the "sealed envelope"): ink lines on the night
 * ground, paper-white labels, brass for what is sealed or keyed, green only for an
 * accepted check and red only for a refusal. Colours come from CSS custom
 * properties (var(--…)) so the drawings follow the page's tokens.
 *
 * - anatomyArt: one bid as the contract stores it. The 32-byte plaintext
 *   (u128 quantity ‖ u16 tick ‖ 14 zero bytes) XORed with keccak(…, K) into ct;
 *   K hashed into keyHash and split 2-of-3; each share hashed on chain and sealed
 *   with ML-KEM-1024 + X25519 to one member, as a 1,752-byte envelope.
 * - keysArt: after closeCommit, members 1 and 2 release with ML-DSA-87; pqcVerify
 *   accepts them and refuses an outsider; any two shares rebuild K, checked
 *   against keyHash, and openBids decrypts.
 * - clearingChart: the demand of the opened bids against the supply, and the one
 *   price where they meet.
 * Each schematic has a separate phone drawing; none is the desktop one shrunk.
 */
import { s } from "../ui.ts";

const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "Geist, system-ui, sans-serif";
const C = {
  ink: "var(--paper)",
  ink2: "var(--paper-2)",
  muted: "var(--muted)",
  line: "var(--line)",
  rule: "var(--rule)",
  vault: "var(--vault)",
  brass: "var(--brass)",
  brassDim: "var(--brass-dim)",
  ok: "var(--ok)",
  bad: "var(--bad)",
};

type A = Record<string, string | number>;
const t = (x: number, y: number, txt: string, a: A = {}) => s("text", { x, y, "font-size": 12, "font-family": SANS, fill: C.ink2, ...a }, txt);
const m = (x: number, y: number, txt: string, a: A = {}) => t(x, y, txt, { "font-family": MONO, "font-size": 11.5, fill: C.ink, ...a });
const box = (x: number, y: number, w: number, h: number, a: A = {}) =>
  s("rect", { x, y, width: w, height: h, rx: 6, fill: C.vault, stroke: C.line, "stroke-width": 1, ...a });
const path = (d: string, a: A = {}) =>
  s("path", { d, fill: "none", stroke: C.line, "stroke-width": 1.25, "stroke-linecap": "round", "stroke-linejoin": "round", "marker-end": "url(#sa-arrow)", ...a });
const g = (a: A, ...kids: SVGElement[]) => s("g", a, ...kids);

let uid = 0;
function root(w: number, h: number, label: string, cls: string): SVGSVGElement {
  const id = ++uid;
  const r = s("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": label, class: cls }) as SVGSVGElement;
  const mk = (name: string, color: string) =>
    s("marker", { id: `${name}-${id}`, viewBox: "0 0 10 10", refX: 8.5, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, s("path", { d: "M1 1L9 5L1 9z", fill: color }));
  r.append(s("defs", {}, mk("sa-arrow", "var(--line)"), mk("sa-arrow-brass", "var(--brass)"), mk("sa-arrow-bad", "var(--bad)")));
  r.dataset.uid = String(id);
  return r;
}

/** Point marker references at this drawing's own markers (ids must be unique on the page). */
function fixMarkers(r: SVGSVGElement): SVGSVGElement {
  const id = r.dataset.uid;
  r.querySelectorAll("[marker-end]").forEach((p) => p.setAttribute("marker-end", p.getAttribute("marker-end")!.replace(/#(sa-arrow[a-z-]*)\)/, `#$1-${id})`)));
  return r;
}

/** 32 byte cells: quantity (16), tick (2), zero padding (14). `scrambled` draws ct instead. */
function byteStrip(x: number, y: number, cell: number, scrambled: boolean): SVGElement {
  const out = g({});
  // A fixed shade per cell for ct: deterministic, so the drawing never changes.
  const shade = (i: number) => [0.25, 0.7, 0.45, 0.9, 0.35, 0.6, 0.8, 0.3][(i * 5 + 3) % 8]!;
  for (let i = 0; i < 32; i++) {
    const kind = i < 16 ? "q" : i < 18 ? "t" : "z";
    out.append(
      s("rect", {
        x: x + i * cell,
        y,
        width: cell - 2,
        height: 18,
        rx: 1.5,
        fill: scrambled || kind !== "z" ? C.brass : "none",
        "fill-opacity": scrambled ? shade(i) : kind === "q" ? 0.55 : 1,
        stroke: kind === "z" && !scrambled ? C.line : "none",
        "stroke-width": 1,
      }),
    );
  }
  return out;
}

const ANATOMY_LABEL =
  "One sealed bid. In the browser the 32-byte plaintext, a 16-byte quantity, a 2-byte tick and 14 zero bytes, is XORed with keccak of the context and a fresh key K into the ciphertext ct. K is hashed into keyHash and split two of three into shares s1, s2, s3. commitBid stores ct, keyHash and the three share hashes, pulls escrow and bond, and emits three 1,752-byte envelopes, each sealing one share with ML-KEM-1024 and X25519 to one committee member's registered key.";

/** One sealed bid, as the contract stores it. Desktop. */
export function anatomyArt(): SVGSVGElement {
  const r = root(1040, 400, ANATOMY_LABEL, "art art-wide anatomy");
  const cell = 7;
  r.append(
    t(0, 18, "In the bidder's browser", { "font-size": 12.5, fill: C.muted }),
    byteStrip(0, 44, cell, false),
    t(0, 80, "quantity · u128", { "font-size": 11.5 }),
    s("path", { d: `M${16 * cell + 6} 40V34H${16 * cell + 40}`, fill: "none", stroke: C.line, "stroke-width": 1 }),
    t(16 * cell + 44, 37, "tick · u16", { "font-size": 11.5 }),
    t(18 * cell + 4, 80, "14 zero bytes", { "font-size": 11.5, fill: C.muted }),
    m(0, 112, "⊕ keccak(chain, auction, bidder, seq, K)", { fill: C.brass }),
    byteStrip(0, 128, cell, true),
    m(0, 166, "ct · 32 bytes", { fill: C.ink2 }),
    s("circle", { cx: 34, cy: 238, r: 22, fill: "none", stroke: C.brass, "stroke-width": 1.5 }),
    m(34, 243, "K", { "text-anchor": "middle", "font-size": 15, fill: C.brass, "font-weight": 500 }),
    t(0, 370, "K: a fresh key, random in F_p,", { "font-size": 11.5 }),
    t(0, 386, "split 2 of 3 (Shamir)", { "font-size": 11.5, fill: C.muted }),
  );
  [0, 1, 2].forEach((i) => {
    const x = 6 + i * 76;
    r.append(path(`M34 260 C34 290 ${x + 28} 286 ${x + 28} 312`), box(x, 316, 56, 26, { stroke: C.brass, fill: "none" }), m(x + 28, 333, `s${i + 1}`, { "text-anchor": "middle", fill: C.brass }));
  });

  const bx = 400;
  r.append(t(bx, 18, "commitBid, on chain", { "font-size": 12.5, fill: C.muted }), box(bx, 34, 300, 330));
  const rows: [string, string, string][] = [
    ["ct", "32 B", "stored"],
    ["keyHash = H(K)", "32 B", "stored"],
    ["H(s1) H(s2) H(s3)", "3 × 32 B", "stored"],
    ["escrow + bond", "quote token", "pulled"],
    ["envelopes", "3 × 1,752 B", "in the event only"],
  ];
  rows.forEach(([k, size, how], i) => {
    const y = 66 + i * 60;
    if (i) r.append(s("line", { x1: bx, y1: y - 22, x2: bx + 300, y2: y - 22, stroke: C.rule, "stroke-width": 1 }));
    r.append(
      m(bx + 16, y, k, { "font-size": 12.5 }),
      m(bx + 284, y, size, { "text-anchor": "end", fill: C.ink2 }),
      t(bx + 16, y + 18, how, { "font-size": 11, fill: i === 4 ? C.brass : C.muted }),
    );
  });
  r.append(
    path(`M228 137 C300 137 330 66 ${bx - 4} 66`),
    path(`M57 238 C200 238 300 126 ${bx - 4} 126`),
    path(`M232 329 C320 329 330 186 ${bx - 4} 186`),
  );

  const cx = 800;
  r.append(t(cx, 18, "Each member's registered key", { "font-size": 12.5, fill: C.muted }));
  [0, 1, 2].forEach((i) => {
    const y = 60 + i * 104;
    r.append(
      path(`M${bx + 300} 306 C${bx + 360} 306 ${cx - 50} ${y + 26} ${cx - 6} ${y + 26}`, { stroke: C.brassDim, "marker-end": "url(#sa-arrow-brass)" }),
      box(cx, y, 240, 52),
      s("path", { d: `M${cx + 16} ${y + 16}h30v20h-30zM${cx + 16} ${y + 16}l15 10 15-10`, fill: "none", stroke: C.brass, "stroke-width": 1.25, "stroke-linejoin": "round" }),
      s("rect", { x: cx + 28, y: y + 23, width: 6, height: 6, rx: 1, fill: C.brass }),
      t(cx + 60, y + 23, `Member ${i + 1}`, { "font-size": 13, fill: C.ink, "font-weight": 500 }),
      m(cx + 60, y + 40, "ML-KEM-1024 + X25519", { "font-size": 11, fill: C.ink2 }),
    );
  });
  r.append(t(cx, 390, "each opens only its own share", { "font-size": 11, fill: C.muted }));
  return fixMarkers(r);
}

/** One sealed bid, top to bottom, for a phone. */
export function anatomyArtPhone(): SVGSVGElement {
  const r = root(340, 640, ANATOMY_LABEL, "art art-phone anatomy");
  const cell = 9.5;
  r.append(
    t(0, 16, "In the bidder's browser", { "font-size": 13, fill: C.muted }),
    byteStrip(10, 32, cell, false),
    t(10, 68, "quantity · u128", { "font-size": 12 }),
    s("path", { d: `M${10 + 16 * cell + 8} 28V22H${10 + 16 * cell + 40}`, fill: "none", stroke: C.line, "stroke-width": 1 }),
    t(10 + 16 * cell + 44, 26, "tick · u16", { "font-size": 12 }),
    t(10 + 18 * cell + 6, 68, "14 zero bytes", { "font-size": 12, fill: C.muted }),
    m(10, 98, "⊕ keccak(…, K)", { fill: C.brass, "font-size": 12.5 }),
    byteStrip(10, 112, cell, true),
    m(10, 150, "ct · 32 bytes", { fill: C.ink2, "font-size": 12.5 }),
    s("circle", { cx: 32, cy: 196, r: 20, fill: "none", stroke: C.brass, "stroke-width": 1.5 }),
    m(32, 201, "K", { "text-anchor": "middle", "font-size": 15, fill: C.brass }),
    t(62, 192, "fresh key, split 2 of 3", { "font-size": 12.5 }),
    t(62, 208, "H(K) goes on chain as keyHash", { "font-size": 12, fill: C.muted }),
    t(0, 252, "commitBid, on chain", { "font-size": 13, fill: C.muted }),
    box(0, 264, 340, 210),
  );
  const rows: [string, string][] = [
    ["ct", "32 B"],
    ["keyHash = H(K)", "32 B"],
    ["H(s1) H(s2) H(s3)", "3 × 32 B"],
    ["escrow + bond", "pulled"],
    ["envelopes (event)", "3 × 1,752 B"],
  ];
  rows.forEach(([k, v], i) => {
    const y = 296 + i * 38;
    if (i) r.append(s("line", { x1: 0, y1: y - 18, x2: 340, y2: y - 18, stroke: C.rule, "stroke-width": 1 }));
    r.append(m(14, y + 2, k, { "font-size": 12.5, fill: i === 4 ? C.brass : C.ink }), m(326, y + 2, v, { "text-anchor": "end", fill: C.ink2, "font-size": 12.5 }));
  });
  r.append(t(0, 512, "Each envelope opens for one member only", { "font-size": 13, fill: C.muted }));
  [0, 1, 2].forEach((i) => {
    const x = i * 116;
    r.append(
      box(x, 528, 108, 92),
      s("path", { d: `M${x + 39} 546h30v20h-30zM${x + 39} 546l15 10 15-10`, fill: "none", stroke: C.brass, "stroke-width": 1.25 }),
      s("rect", { x: x + 51, y: 553, width: 6, height: 6, rx: 1, fill: C.brass }),
      t(x + 54, 590, `Member ${i + 1}`, { "text-anchor": "middle", "font-size": 12.5, fill: C.ink }),
      m(x + 54, 607, "ML-KEM-1024", { "text-anchor": "middle", "font-size": 11, fill: C.ink2 }),
    );
  });
  return fixMarkers(r);
}

const KEYS_LABEL =
  "After closeCommit, members 1 and 2 each sign one release with ML-DSA-87. pqcVerify accepts both and refuses an outsider's forged release with ReleaseSignatureInvalid. Member 3 is offline. Any two shares rebuild K, which must match keyHash; then openBids decrypts every bid.";

/** Two of three keys meet. Desktop. */
export function keysArt(): SVGSVGElement {
  const r = root(1040, 320, KEYS_LABEL, "art art-wide keys");
  const members: [string, string, "ok" | "off" | "bad"][] = [
    ["Member 1", "ML-DSA-87 release", "ok"],
    ["Member 2", "ML-DSA-87 release", "ok"],
    ["Member 3", "offline", "off"],
    ["Outsider", "forged release", "bad"],
  ];
  members.forEach(([who, what, st], i) => {
    const y = 6 + i * 78;
    const stroke = st === "bad" ? C.bad : st === "off" ? C.rule : C.brass;
    r.append(
      box(0, y, 230, 58, st === "off" ? { "stroke-dasharray": "4 4" } : { stroke }),
      g(
        { fill: "none", stroke: st === "off" ? C.muted : st === "bad" ? C.bad : C.brass, "stroke-width": 1.5, "stroke-linecap": "round" },
        s("circle", { cx: 26, cy: y + 29, r: 7 }),
        s("path", { d: `M33 ${y + 29}h18M45 ${y + 29}v6M50 ${y + 29}v4` }),
      ),
      t(66, y + 25, who, { "font-size": 13, fill: st === "off" ? C.muted : C.ink, "font-weight": 500 }),
      m(66, y + 43, what, { "font-size": 11, fill: st === "bad" ? C.bad : C.ink2 }),
    );
    if (st === "ok") r.append(path(`M232 ${y + 29} C300 ${y + 29} 300 128 362 128`, { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)", class: "draw", pathLength: 1 }));
    if (st === "bad") r.append(path(`M232 ${y + 29} C310 ${y + 29} 320 168 362 160`, { stroke: C.bad, "marker-end": "url(#sa-arrow-bad)", "stroke-dasharray": "3 4" }));
  });
  r.append(
    box(366, 96, 200, 78, { stroke: C.ink2 }),
    m(466, 126, "pqcVerify", { "text-anchor": "middle", "font-size": 14, "font-weight": 500 }),
    t(466, 146, "key from pqcKeyStatus", { "text-anchor": "middle", "font-size": 11, fill: C.muted }),
    t(466, 162, "two accepted", { "text-anchor": "middle", "font-size": 11, fill: C.ok }),
    m(466, 214, "ReleaseSignatureInvalid", { "text-anchor": "middle", fill: C.bad, "font-size": 11.5 }),
    t(466, 232, "the forged one reverts", { "text-anchor": "middle", "font-size": 11, fill: C.muted }),
    path("M566 135H632", { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)", class: "draw", pathLength: 1 }),
    box(636, 96, 196, 78),
    m(734, 126, "K from s1, s2", { "text-anchor": "middle", "font-size": 13 }),
    t(734, 146, "Lagrange, any two of three", { "text-anchor": "middle", "font-size": 11, fill: C.muted }),
    t(734, 162, "H(K) = keyHash", { "text-anchor": "middle", "font-size": 11, fill: C.ok }),
    path("M832 135H898", { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)", class: "draw", pathLength: 1 }),
    box(902, 96, 138, 78, { stroke: C.brass }),
    m(971, 126, "openBids", { "text-anchor": "middle", "font-size": 13, fill: C.brass }),
    t(971, 146, "every bid", { "text-anchor": "middle", "font-size": 11, fill: C.muted }),
    t(971, 162, "decrypted on chain", { "text-anchor": "middle", "font-size": 11, fill: C.muted }),
  );
  return fixMarkers(r);
}

/** Two of three keys meet, top to bottom, for a phone. */
export function keysArtPhone(): SVGSVGElement {
  const r = root(340, 560, KEYS_LABEL, "art art-phone keys");
  const members: [string, string, "ok" | "off" | "bad"][] = [
    ["Member 1", "ML-DSA-87", "ok"],
    ["Member 2", "ML-DSA-87", "ok"],
    ["Member 3", "offline", "off"],
    ["Outsider", "forged", "bad"],
  ];
  members.forEach(([who, what, st], i) => {
    const x = (i % 2) * 174;
    const y = Math.floor(i / 2) * 70;
    const stroke = st === "bad" ? C.bad : st === "off" ? C.rule : C.brass;
    r.append(
      box(x, y, 166, 56, st === "off" ? { "stroke-dasharray": "4 4" } : { stroke }),
      t(x + 14, y + 24, who, { "font-size": 13.5, fill: st === "off" ? C.muted : C.ink, "font-weight": 500 }),
      m(x + 14, y + 42, what, { "font-size": 12, fill: st === "bad" ? C.bad : C.ink2 }),
    );
  });
  r.append(
    path("M83 56 C83 140 150 160 160 196", { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)" }),
    path("M257 56 C257 100 236 120 222 140 C200 170 190 180 182 196", { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)" }),
    box(60, 200, 220, 70, { stroke: C.ink2 }),
    m(170, 228, "pqcVerify", { "text-anchor": "middle", "font-size": 15 }),
    t(170, 250, "two accepted, the forged one reverts", { "text-anchor": "middle", "font-size": 12, fill: C.muted }),
    path("M170 270V300", { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)" }),
    box(60, 304, 220, 70),
    m(170, 332, "K from s1, s2", { "text-anchor": "middle", "font-size": 14 }),
    t(170, 354, "H(K) = keyHash", { "text-anchor": "middle", "font-size": 12, fill: C.ok }),
    path("M170 374V404", { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)" }),
    box(60, 408, 220, 70, { stroke: C.brass }),
    m(170, 436, "openBids", { "text-anchor": "middle", "font-size": 14, fill: C.brass }),
    t(170, 458, "every bid decrypted on chain", { "text-anchor": "middle", "font-size": 12, fill: C.muted }),
    m(0, 520, "ReleaseSignatureInvalid", { fill: C.bad, "font-size": 12.5 }),
    t(0, 540, "what the outsider's release got back", { "font-size": 12, fill: C.muted }),
  );
  return fixMarkers(r);
}

// ---------------------------------------------------------------- the clearing chart

export interface OpenedBid {
  label: string;
  quantity: number;
  price: number;
  allocated: number;
}

/**
 * Demand (the opened bids, highest limit first, as steps of width = quantity)
 * against the supply line; the price where they meet is drawn across.
 * Filled steps are what each bid was allocated; the faded rest went unfilled.
 */
export function clearingChart(bids: OpenedBid[], supply: number, price: number, unit: { sale: string; quote: string }, phone = false): SVGSVGElement {
  const W = phone ? 340 : 620;
  const H = phone ? 300 : 360;
  const L = phone ? 44 : 56;
  const R = 24;
  const T = 30;
  const B = 48;
  const sorted = [...bids].sort((a, b) => b.price - a.price);
  const totalQ = sorted.reduce((sum, b) => sum + b.quantity, 0);
  const maxQ = Math.max(totalQ, supply) * 1.1;
  const maxP = Math.ceil(Math.max(...sorted.map((b) => b.price), price) + 0.5);
  const X = (q: number) => L + (q / maxQ) * (W - L - R);
  const Y = (p: number) => H - B - (p / maxP) * (H - T - B);
  const r = s("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    class: `clearing-chart ${phone ? "art-phone" : "art-wide"}`,
    "aria-label": `Demand of the opened bids against ${supply} ${unit.sale} for sale; they meet at ${price.toFixed(2)} ${unit.quote}.`,
  }) as SVGSVGElement;
  for (let p = 0; p <= maxP; p += 1) {
    r.append(
      s("line", { x1: L, y1: Y(p), x2: W - R, y2: Y(p), stroke: C.rule, "stroke-width": 1 }),
      t(L - 10, Y(p) + 4, p.toFixed(2), { "text-anchor": "end", "font-size": 11, "font-family": MONO, fill: C.muted }),
    );
  }
  const step = maxQ > 200 ? 100 : 50;
  for (let q = 0; q <= maxQ; q += step) r.append(t(X(q), H - B + 20, String(q), { "text-anchor": "middle", "font-size": 11, "font-family": MONO, fill: C.muted }));
  r.append(t(L, 14, `${unit.quote} per ${unit.sale}`, { "font-size": 11, fill: C.muted }), t(W - R, H - 6, `${unit.sale}, cumulative`, { "text-anchor": "end", "font-size": 11, fill: C.muted }));
  // Demand as a step line; the allocated part filled lightly, the unfilled part only outlined.
  let q0 = 0;
  let d = `M${X(0)} ${Y(0)}`;
  for (const b of sorted) {
    const x0 = X(q0);
    const xa = X(q0 + b.allocated);
    const x1 = X(q0 + b.quantity);
    d += ` V${Y(b.price)} H${x1}`;
    const grp = g({ class: "bar" });
    grp.append(s("title", {}, `${b.label}: ${b.quantity} ${unit.sale} at most ${b.price.toFixed(2)} ${unit.quote}; allocated ${b.allocated}`));
    if (b.allocated > 0) grp.append(s("rect", { x: x0 + 1, y: Y(b.price), width: Math.max(0, xa - x0 - 2), height: Y(0) - Y(b.price), fill: C.brass, "fill-opacity": 0.22 }));
    if (b.allocated < b.quantity) grp.append(s("rect", { x: xa + 1, y: Y(b.price), width: Math.max(0, x1 - xa - 2), height: Y(0) - Y(b.price), fill: "none", stroke: C.brassDim, "stroke-dasharray": "3 3" }));
    grp.append(m(x0 + 10, Y(b.price) + 20, b.label, { "font-size": 11.5, fill: C.ink }), t(x0 + 10, Y(b.price) + 36, `${b.quantity} at ≤ ${b.price.toFixed(2)}`, { "font-size": 11.5, fill: C.ink2 }));
    r.append(grp);
    q0 += b.quantity;
  }
  d += ` V${Y(0)}`;
  r.append(s("path", { d, fill: "none", stroke: C.brass, "stroke-width": 2, "stroke-linejoin": "round", class: "demand" }));
  r.append(
    s("line", { x1: X(supply), y1: T, x2: X(supply), y2: Y(0), stroke: C.ink, "stroke-width": 1.25, "stroke-dasharray": "4 4" }),
    t(X(supply) + 6, T + 10, `${supply} for sale`, { "font-size": 11.5, fill: C.ink }),
    s("line", { x1: L, y1: Y(price), x2: W - R, y2: Y(price), stroke: C.ink, "stroke-width": 1.25 }),
    m(L + 10, Y(price) + 20, `clears at ${price.toFixed(2)}`, { "font-size": 12, fill: C.ink, "font-weight": 500 }),
  );
  return r;
}

// ---------------------------------------------------------------- the problem: one key against a split key

const PROBLEM_LABEL =
  "Left, the usual recipe: every bid is encrypted to one auction key, so its holder can read all bids at any time, and if the key is lost no bid opens. Right, Peal Sealed Auction: each bid has its own key K, split into three shares held by three members; after closeCommit any two members open it, and no single party can open it early.";

function envGlyph(x: number, y: number, color: string): SVGElement {
  return g(
    {},
    s("path", { d: `M${x} ${y}h28v19h-28zM${x} ${y}l14 9 14-9`, fill: "none", stroke: color, "stroke-width": 1.25, "stroke-linejoin": "round" }),
    s("rect", { x: x + 11, y: y + 6, width: 6, height: 6, rx: 1, fill: color }),
  );
}

/** One auction key against a split key. Desktop. */
export function problemArt(): SVGSVGElement {
  const r = root(1040, 330, PROBLEM_LABEL, "art art-wide problem");
  // Left: one auction key.
  r.append(t(0, 16, "The usual recipe: one auction key", { "font-size": 13, fill: C.ink, "font-weight": 500 }), box(0, 32, 490, 260, { fill: "none", stroke: C.rule }));
  [0, 1, 2].forEach((i) => {
    const y = 72 + i * 70;
    r.append(envGlyph(28, y, C.ink2), m(66, y + 14, `bid ${i}`, { fill: C.ink2 }), path(`M110 ${y + 10} C170 ${y + 10} 170 152 214 152`, { stroke: C.bad }));
  });
  r.append(
    s("circle", { cx: 238, cy: 152, r: 22, fill: "none", stroke: C.bad, "stroke-width": 1.5 }),
    m(238, 157, "K", { "text-anchor": "middle", "font-size": 14, fill: C.bad }),
    t(238, 196, "one auction key", { "text-anchor": "middle", "font-size": 11.5 }),
    path("M262 152H318", { stroke: C.bad, "marker-end": "url(#sa-arrow-bad)" }),
    box(322, 120, 150, 64, { stroke: C.bad }),
    t(338, 146, "Its holder", { "font-size": 13, fill: C.ink, "font-weight": 500 }),
    t(338, 164, "reads every bid", { "font-size": 12, fill: C.bad }),
    t(20, 270, "Early, at any time. One leak exposes all bids; a lost key opens none.", { "font-size": 12, fill: C.ink2 }),
  );
  // Right: a split key per bid.
  const ox = 550;
  r.append(t(ox, 16, "Peal Sealed Auction: a split key per bid", { "font-size": 13, fill: C.ink, "font-weight": 500 }), box(ox, 32, 490, 260, { fill: "none", stroke: C.rule }));
  const memY = [86, 152, 218];
  [0, 1, 2].forEach((i) => {
    const y = 72 + i * 70;
    r.append(envGlyph(ox + 22, y, C.brass), s("circle", { cx: ox + 92, cy: y + 10, r: 11, fill: "none", stroke: C.brass, "stroke-width": 1.25 }), m(ox + 92, y + 14, "K", { "text-anchor": "middle", "font-size": 10.5, fill: C.brass }));
    for (const my of memY) r.append(s("path", { d: `M${ox + 104} ${y + 10} C${ox + 160} ${y + 10} ${ox + 170} ${my} ${ox + 214} ${my}`, fill: "none", stroke: C.brassDim, "stroke-width": 1 }));
  });
  memY.forEach((y, i) => {
    r.append(box(ox + 216, y - 16, 104, 32, i === 2 ? { "stroke-dasharray": "4 4" } : { stroke: C.brassDim }), t(ox + 268, y + 4, `member ${i + 1}`, { "text-anchor": "middle", "font-size": 12, fill: i === 2 ? C.muted : C.ink }));
    if (i < 2) r.append(path(`M${ox + 320} ${y} C${ox + 350} ${y} ${ox + 350} 152 ${ox + 372} 152`, { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)" }));
  });
  r.append(
    box(ox + 376, 122, 100, 60, { stroke: C.brass }),
    t(ox + 426, 146, "any two", { "text-anchor": "middle", "font-size": 12.5, fill: C.ink, "font-weight": 500 }),
    m(ox + 426, 164, "after close", { "text-anchor": "middle", "font-size": 11, fill: C.ok }),
    t(ox + 20, 270, "One share reveals nothing. Before closeCommit no release is accepted.", { "font-size": 12, fill: C.ink2 }),
  );
  return fixMarkers(r);
}

/** One auction key against a split key, for a phone. */
export function problemArtPhone(): SVGSVGElement {
  const r = root(340, 540, PROBLEM_LABEL, "art art-phone problem");
  r.append(t(0, 16, "The usual recipe: one auction key", { "font-size": 13.5, fill: C.ink, "font-weight": 500 }), box(0, 30, 340, 200, { fill: "none", stroke: C.rule }));
  [0, 1, 2].forEach((i) => {
    const x = 24 + i * 52;
    r.append(envGlyph(x, 60, C.ink2), path(`M${x + 14} 84 C${x + 14} 110 120 104 150 118`, { stroke: C.bad }));
  });
  r.append(
    s("circle", { cx: 170, cy: 128, r: 18, fill: "none", stroke: C.bad, "stroke-width": 1.5 }),
    m(170, 133, "K", { "text-anchor": "middle", "font-size": 13, fill: C.bad }),
    path("M190 128H226", { stroke: C.bad, "marker-end": "url(#sa-arrow-bad)" }),
    t(232, 124, "its holder", { "font-size": 12.5, fill: C.ink }),
    t(232, 140, "reads all", { "font-size": 12.5, fill: C.bad }),
    t(16, 190, "early, at any time; a lost key", { "font-size": 12.5, fill: C.ink2 }),
    t(16, 208, "opens nothing", { "font-size": 12.5, fill: C.ink2 }),
  );
  r.append(t(0, 272, "Peal Sealed Auction: a split key per bid", { "font-size": 13.5, fill: C.ink, "font-weight": 500 }), box(0, 286, 340, 250, { fill: "none", stroke: C.rule }));
  r.append(envGlyph(24, 312, C.brass), s("circle", { cx: 84, cy: 322, r: 11, fill: "none", stroke: C.brass, "stroke-width": 1.25 }), m(84, 326, "K", { "text-anchor": "middle", "font-size": 10.5, fill: C.brass }), t(104, 326, "each bid has its own key", { "font-size": 12.5 }));
  [0, 1, 2].forEach((i) => {
    const x = 16 + i * 106;
    r.append(
      s("path", { d: `M84 334 C84 360 ${x + 48} 352 ${x + 48} 378`, fill: "none", stroke: C.brassDim, "stroke-width": 1 }),
      box(x, 380, 96, 32, i === 2 ? { "stroke-dasharray": "4 4" } : { stroke: C.brassDim }),
      t(x + 48, 400, `member ${i + 1}`, { "text-anchor": "middle", "font-size": 12, fill: i === 2 ? C.muted : C.ink }),
    );
    if (i < 2) r.append(path(`M${x + 48} 412 C${x + 48} 436 170 432 170 452`, { stroke: C.brass, "marker-end": "url(#sa-arrow-brass)" }));
  });
  r.append(
    box(100, 456, 140, 44, { stroke: C.brass }),
    t(170, 476, "any two", { "text-anchor": "middle", "font-size": 12.5, fill: C.ink }),
    m(170, 492, "after close", { "text-anchor": "middle", "font-size": 11, fill: C.ok }),
    t(16, 524, "one share reveals nothing", { "font-size": 12.5, fill: C.ink2 }),
  );
  return fixMarkers(r);
}

// ---------------------------------------------------------------- the timeline: who can read a bid, when

const TIMELINE_LABEL =
  "The auction's phases on a time line: bids are committed while open; closeCommit freezes them; members release until the release deadline; openBids and finalize decrypt and clear; then claims. Below, who can read a bid in each phase: the bidder always reads its own; one member never; two members, through releases, only after closeCommit; everyone after openBids, when the opened bid is public on chain. This assumes fewer than two members collude.";

/** When can anyone read a bid? Desktop. */
export function timelineArt(): SVGSVGElement {
  const r = root(1040, 330, TIMELINE_LABEL, "art art-wide timeline");
  const L = 190;
  const xs = [L, 420, 650, 840, 1030]; // phase boundaries
  const phases: [string, string][] = [
    ["CommitOpen", "bids arrive sealed"],
    ["Closed", "members release"],
    ["opening", "openBids, finalize"],
    ["Settled", "claims"],
  ];
  const calls = ["createAuction", "closeCommit", "releaseDeadline", "finalize", ""];
  r.append(s("line", { x1: L, y1: 64, x2: 1030, y2: 64, stroke: C.line, "stroke-width": 1.25 }));
  xs.slice(0, 4).forEach((x, i) => {
    r.append(s("line", { x1: x, y1: 56, x2: x, y2: 280, stroke: i === 1 ? C.brass : C.rule, "stroke-width": i === 1 ? 1.25 : 1, "stroke-dasharray": i === 1 ? "none" : "2 4" }), m(x + 6, 50, calls[i]!, { "font-size": 11, fill: i === 1 ? C.brass : C.muted }));
  });
  phases.forEach(([name, what], i) => {
    r.append(m(xs[i]! + 10, 88, name, { "font-size": 12.5 }), t(xs[i]! + 10, 106, what, { "font-size": 11.5, fill: C.muted }));
  });
  // Who can read a bid: [label, readable from phase index (or -1 never), note]
  const rows: [string, number, string][] = [
    ["The bidder (its own bid)", 0, "always: it sealed it"],
    ["One committee member", -1, "never: a share is noise"],
    ["Two members, releasing", 1, "after closeCommit only"],
    ["Everyone", 2, "after openBids, on chain"],
  ];
  r.append(t(0, 136, "Who can read a bid", { "font-size": 12, fill: C.muted }));
  rows.forEach(([who, from, note], i) => {
    const y = 148 + i * 32;
    r.append(t(0, y + 16, who, { "font-size": 12.5, fill: C.ink }));
    for (let p = 0; p < 4; p++) {
      const open = from >= 0 && p >= from;
      r.append(s("rect", { x: xs[p]! + 4, y, width: xs[p + 1]! - xs[p]! - 8, height: 22, rx: 3, fill: open ? C.brass : "none", "fill-opacity": open ? 0.22 : 0, stroke: open ? C.brassDim : C.rule, "stroke-dasharray": open ? "none" : "3 3" }));
      if (p === Math.max(from, 0)) r.append(t(xs[p]! + 14, y + 15, note, { "font-size": 11.5, fill: open ? C.ink : C.muted }));
    }
  });
  r.append(t(0, 314, "Trust assumption: fewer than two members collude. Two colluding members could combine their shares off chain at any time; the threat model says so.", { "font-size": 11.5, fill: C.ink2 }));
  return fixMarkers(r);
}

/** When can anyone read a bid? For a phone: phases down, readers across. */
export function timelineArtPhone(): SVGSVGElement {
  const r = root(340, 480, TIMELINE_LABEL, "art art-phone timeline");
  const cols = ["bidder", "1 member", "2 releasing", "everyone"];
  const cx = [150, 198, 246, 300];
  cols.forEach((c, i) => r.append(t(cx[i]!, 16, c, { "text-anchor": "middle", "font-size": 11, fill: C.muted })));
  const phases: [string, string, boolean[]][] = [
    ["CommitOpen", "bids arrive sealed", [true, false, false, false]],
    ["closeCommit", "the set is frozen", [true, false, true, false]],
    ["Closed", "members release", [true, false, true, false]],
    ["openBids", "bids decrypted", [true, false, true, true]],
    ["Settled", "claims", [true, false, true, true]],
  ];
  phases.forEach(([name, what, open], i) => {
    const y = 40 + i * 80;
    r.append(
      s("line", { x1: 0, y1: y, x2: 340, y2: y, stroke: i === 1 ? C.brass : C.rule, "stroke-width": 1 }),
      m(0, y + 26, name, { "font-size": 12.5, fill: i === 1 ? C.brass : C.ink }),
      t(0, y + 44, what, { "font-size": 11.5, fill: C.muted }),
    );
    open.forEach((o, j) => r.append(s("rect", { x: cx[j]! - 18, y: y + 16, width: 36, height: 36, rx: 4, fill: o ? C.brass : "none", "fill-opacity": o ? 0.22 : 0, stroke: o ? C.brassDim : C.rule, "stroke-dasharray": o ? "none" : "3 3" }), o ? check(cx[j]!, y + 34) : lockMini(cx[j]!, y + 34)));
  });
  r.append(t(0, 448, "Filled: can read the bid. Dashed: sealed to them.", { "font-size": 12, fill: C.ink2 }), t(0, 466, "Assumes fewer than two members collude.", { "font-size": 12, fill: C.muted }));
  return fixMarkers(r);
}

function check(cx: number, cy: number): SVGElement {
  return s("path", { d: `M${cx - 6} ${cy}l4 4 8-9`, fill: "none", stroke: C.brass, "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round" });
}

function lockMini(cx: number, cy: number): SVGElement {
  return g(
    { fill: "none", stroke: C.muted, "stroke-width": 1.25, "stroke-linecap": "round" },
    s("path", { d: `M${cx - 4} ${cy - 2}v-3a4 4 0 018 0v3` }),
    s("rect", { x: cx - 6, y: cy - 2, width: 12, height: 9, rx: 1.5 }),
  );
}
