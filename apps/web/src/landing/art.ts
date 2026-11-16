/**
 * art.ts - the landing page's hand-made illustrations, drawn with the real names.
 *
 * - heroArt / heroArtPhone: the whole mechanism on one picture. A bid encrypted
 *   under a fresh key K; K split into three shares, each sealed with ML-KEM-1024
 *   to one committee member; after closeCommit two members release with ML-DSA-87
 *   (pqcVerify), the third is offline; the contract rebuilds K, opens the bids and
 *   clears them at one price. The figures are the testnet demo run's.
 * - railArt: four panels, one per "how it works" step, highlighted by the step rail.
 *
 * Shapes are white cards with hairlines on the accent ramp; green and red only for
 * an outcome. Paths that carry meaning have pathLength 1 so CSS can draw them in
 * once (behind prefers-reduced-motion: no-preference); the still state reads alone.
 */
import { s } from "../ui.ts";

const C = {
  ink: "#111827",
  ink2: "#374151",
  muted: "#6b7280",
  soft: "#9ca3af",
  line: "#e5e7eb",
  a50: "#eff6ff",
  a100: "#dbeafe",
  a200: "#bfdbfe",
  a300: "#93c5fd",
  a400: "#60a5fa",
  a600: "#2563eb",
  a800: "#1e40af",
  green: "#16a34a",
  greenWeak: "#f0fdf4",
  red: "#dc2626",
  redWeak: "#fef2f2",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type A = Record<string, string | number>;
const text = (x: number, y: number, t: string, a: A = {}) => s("text", { x, y, "font-size": 12, fill: C.muted, ...a }, t);
const card = (x: number, y: number, w: number, hh: number, a: A = {}) =>
  s("rect", { x, y, width: w, height: hh, rx: 12, fill: "#fff", stroke: C.line, "stroke-width": 1, ...a });
const flow = (d: string, a: A = {}) =>
  s("path", { d, fill: "none", stroke: C.a300, "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 1, class: "draw", ...a });
const g = (a: A, ...kids: SVGElement[]) => s("g", a, ...kids);

function lockGlyph(cx: number, cy: number, color = C.a600): SVGElement {
  return g(
    { transform: `translate(${cx - 6} ${cy - 7})`, fill: "none", stroke: color, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" },
    s("path", { d: "M2.5 6.5V4.5a3.5 3.5 0 017 0v2" }),
    s("rect", { x: 1, y: 6.5, width: 10, height: 7, rx: 1.5, fill: "#fff" }),
  );
}

function check(cx: number, cy: number, color = C.green): SVGElement {
  return s("path", { d: `M${cx - 4} ${cy}l3 3 5.5-6`, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" });
}

function envelope(cx: number, y: number, w = 108, label = "ML-KEM-1024"): SVGElement {
  const x = cx - w / 2;
  return g(
    { class: "pop" },
    s("rect", { x, y, width: w, height: 50, rx: 8, fill: C.a50, stroke: C.a300, "stroke-width": 1.5 }),
    s("path", { d: `M${x + 1} ${y + 2} L${cx} ${y + 20} L${x + w - 1} ${y + 2}`, fill: "none", stroke: C.a300, "stroke-width": 1.5, "stroke-linejoin": "round" }),
    s("rect", { x: cx - 5, y: y + 15, width: 10, height: 10, rx: 2, fill: C.a600 }),
    text(cx, y + 42, label, { "text-anchor": "middle", "font-size": 11, "font-family": MONO, fill: C.a800 }),
  );
}

function member(cx: number, y: number, n: number, on: boolean, w = 140): SVGElement {
  const x = cx - w / 2;
  return g(
    {},
    card(x, y, w, 58, on ? {} : { "stroke-dasharray": "4 4", stroke: C.soft }),
    s("circle", { cx: x + 26, cy: y + 29, r: 13, fill: on ? C.a50 : "#fff", stroke: on ? C.a600 : C.soft, "stroke-width": 1.6 }),
    text(x + 26, y + 33.5, String(n), { "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: on ? C.a600 : C.soft }),
    text(x + 48, y + 26, `Member ${n}`, { "font-size": 13, "font-weight": 600, fill: on ? C.ink : C.muted }),
    text(x + 48, y + 43, on ? "released" : "offline", { fill: on ? C.green : C.soft, class: on ? "pop late" : "" }),
  );
}

/** The chain strip: the contract's calls in order, with what each does. */
function chainBar(x: number, y: number, w: number, steps: [string, string, boolean?][]): SVGElement {
  const out = g({}, card(x, y, w, 96), text(x + 16, y + 22, "SealedAuction on QoreChain", { "font-size": 12, fill: C.muted }));
  const x0 = x + 52;
  const x1 = x + w - 52;
  const ty = y + 58;
  out.append(s("path", { d: `M${x0} ${ty}H${x1}`, stroke: C.a100, "stroke-width": 2, "stroke-linecap": "round" }));
  steps.forEach(([call, what, outcome], i) => {
    const cx = x0 + ((x1 - x0) * i) / (steps.length - 1);
    out.append(
      text(cx, ty - 12, call, { "text-anchor": "middle", "font-size": 11.5, "font-family": MONO, fill: C.ink }),
      outcome
        ? g({ class: "pop late" }, s("circle", { cx, cy: ty, r: 9, fill: C.greenWeak, stroke: C.green, "stroke-width": 1.5 }), check(cx, ty))
        : s("circle", { cx, cy: ty, r: 5, fill: C.a600 }),
      text(cx, ty + 24, what, { "text-anchor": "middle", "font-size": 11.5, fill: outcome ? C.green : C.muted }),
    );
  });
  return out;
}

function svgRoot(w: number, hh: number, label: string, cls: string): SVGSVGElement {
  const r = s("svg", { viewBox: `0 0 ${w} ${hh}`, role: "img", "aria-label": label, class: cls }) as SVGSVGElement;
  r.style.fontFamily = "Satoshi, system-ui, sans-serif";
  return r;
}

const HERO_LABEL =
  "A bid of 60 PEAL-T at most 2.50 fUSD is encrypted under a fresh key K in the browser. K is split into three shares, each sealed with ML-KEM-1024 to one committee member. After closeCommit, members 1 and 2 release with ML-DSA-87 signatures that the contract checks with pqcVerify; member 3 is offline. The contract rebuilds K from two shares, opens the bids and clears them at one price, 1.50.";

/** The hero picture, desktop. */
export function heroArt(): SVGSVGElement {
  const r = svgRoot(560, 470, HERO_LABEL, "hero-art art-wide");
  // Row 1: the bid, encrypted under K.
  r.append(
    card(16, 16, 196, 84),
    text(32, 40, "Your bid, in this browser"),
    text(32, 64, "60 PEAL-T", { "font-size": 17, "font-weight": 600, fill: C.ink }),
    text(32, 84, "at most 2.50 fUSD each", { "font-size": 12, fill: C.ink2 }),
    s("circle", { cx: 188, cy: 40, r: 13, fill: C.a50, stroke: C.a200 }),
    lockGlyph(188, 40),
    flow("M214 58H272", { "marker-end": "url(#arrow)" }),
    text(243, 50, "encrypt", { "text-anchor": "middle", "font-size": 11 }),
    s("circle", { cx: 300, cy: 58, r: 22, fill: C.a600 }),
    text(300, 64, "K", { "text-anchor": "middle", "font-size": 17, "font-weight": 600, fill: "#fff" }),
    text(336, 52, "A fresh key K", { "font-size": 13, "font-weight": 600, fill: C.ink }),
    text(336, 70, "split into 3 shares; any 2 rebuild it"),
  );
  // Ciphertext goes straight to the chain.
  r.append(
    s("path", { d: "M34 100V384Q34 414 56 414", fill: "none", stroke: C.a400, "stroke-width": 1.5, "stroke-dasharray": "3 4", "stroke-linecap": "round" }),
    text(26, 250, "ciphertext", { transform: "rotate(-90 26 250)", "text-anchor": "middle", "font-size": 11, fill: C.a600 }),
  );
  // Row 2: three shares fan out to three envelopes.
  const xs = [128, 296, 464];
  for (const cx of xs) r.append(flow(`M300 80C300 112 ${cx} 108 ${cx} 140`));
  xs.forEach((cx) => r.append(envelope(cx, 140)));
  // Row 3: the members.
  xs.forEach((cx, i) => r.append(flow(`M${cx} 190V230`, i === 2 ? { stroke: C.a200 } : {})));
  xs.forEach((cx, i) => r.append(member(cx, 230, i + 1, i < 2)));
  // Releases converge on submitRelease.
  r.append(
    flow("M128 288C128 330 282 324 282 402", { class: "draw late", stroke: C.a600, "marker-end": "url(#arrow-strong)" }),
    flow("M296 288C296 330 282 344 282 402", { class: "draw late", stroke: C.a600 }),
    g({ class: "pop late" }, s("rect", { x: 312, y: 318, width: 118, height: 24, rx: 12, fill: C.a50, stroke: C.a200 }), text(371, 334, "ML-DSA-87 signed", { "text-anchor": "middle", "font-size": 11.5, "font-weight": 600, fill: C.a600 })),
  );
  // Row 4: the contract.
  r.append(
    chainBar(8, 356, 544, [
      ["commitBid", "stored"],
      ["closeCommit", "set frozen"],
      ["submitRelease", "pqcVerify ✓ ✓"],
      ["openBids", "K rebuilt"],
      ["finalize", "1.50 each", true],
    ]),
  );
  r.prepend(defs());
  return r;
}

/** The hero picture on a phone: the same story, drawn top to bottom. */
export function heroArtPhone(): SVGSVGElement {
  const r = svgRoot(340, 520, HERO_LABEL, "hero-art art-phone");
  r.append(
    card(10, 8, 320, 70),
    text(26, 30, "Your bid, in this browser"),
    text(26, 54, "60 PEAL-T at most 2.50 fUSD", { "font-size": 14, "font-weight": 600, fill: C.ink }),
    flow("M170 78V104"),
    s("circle", { cx: 170, cy: 126, r: 20, fill: C.a600 }),
    text(170, 132, "K", { "text-anchor": "middle", "font-size": 16, "font-weight": 600, fill: "#fff" }),
    text(200, 122, "fresh key K,", { "font-size": 12, "font-weight": 600, fill: C.ink }),
    text(200, 138, "split 2 of 3", { "font-size": 12 }),
  );
  const xs = [62, 170, 278];
  for (const cx of xs) r.append(flow(`M170 146C170 166 ${cx} 160 ${cx} 180`));
  xs.forEach((cx) => r.append(envelope(cx, 180, 96, "ML-KEM")));
  xs.forEach((cx, i) => r.append(flow(`M${cx} 230V256`, i === 2 ? { stroke: C.a200 } : {})));
  xs.forEach((cx, i) => {
    const on = i < 2;
    r.append(
      card(cx - 50, 256, 100, 52, on ? {} : { "stroke-dasharray": "4 4", stroke: C.soft }),
      text(cx, 278, `Member ${i + 1}`, { "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: on ? C.ink : C.muted }),
      text(cx, 296, on ? "released" : "offline", { "text-anchor": "middle", "font-size": 11.5, fill: on ? C.green : C.soft }),
    );
  });
  r.append(
    flow("M62 308C62 336 150 330 150 356", { class: "draw late", stroke: C.a600 }),
    flow("M170 308V356", { class: "draw late", stroke: C.a600 }),
    text(186, 340, "ML-DSA-87 · pqcVerify", { "font-size": 11, "font-weight": 600, fill: C.a600 }),
    card(10, 356, 320, 156),
    text(26, 380, "SealedAuction on QoreChain"),
  );
  const rows: [string, string, boolean?][] = [
    ["commitBid", "ciphertext stored"],
    ["closeCommit", "bid set frozen"],
    ["submitRelease ×2", "both signatures checked"],
    ["openBids · finalize", "K rebuilt, 1.50 each", true],
  ];
  rows.forEach(([call, what, ok], i) => {
    const y = 404 + i * 28;
    r.append(
      ok ? g({ class: "pop late" }, s("circle", { cx: 32, cy: y - 4, r: 8, fill: C.greenWeak, stroke: C.green, "stroke-width": 1.4 }), check(32, y - 4)) : s("circle", { cx: 32, cy: y - 4, r: 4.5, fill: C.a600 }),
      text(48, y, call, { "font-size": 11.5, "font-family": MONO, fill: C.ink }),
      text(318, y, what, { "text-anchor": "end", "font-size": 11.5, fill: ok ? C.green : C.muted }),
    );
  });
  r.prepend(defs());
  return r;
}

function defs(): SVGElement {
  const marker = (id: string, color: string) =>
    s("marker", { id, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M1 1L8 5L1 9", fill: "none", stroke: color, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return s("defs", {}, marker("arrow", C.a300), marker("arrow-strong", C.a600));
}

// ---------------------------------------------------------------- the step rail's drawing

/** Panel rectangles in railArt's coordinates, one per step: x, y, w, h. */
export const PANELS: [number, number, number, number][] = [
  [8, 8, 272, 206],
  [292, 8, 272, 206],
  [8, 226, 272, 206],
  [292, 226, 272, 206],
];

function panelFrame(i: number, title: string): SVGElement {
  const [x, y, w, hh] = PANELS[i]!;
  return g(
    {},
    s("rect", { x, y, width: w, height: hh, rx: 14, fill: "#fff", stroke: C.line, class: "panel-frame" }),
    s("circle", { cx: x + 24, cy: y + 24, r: 11, fill: C.a50 }),
    text(x + 24, y + 28, String(i + 1), { "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: C.a600 }),
    text(x + 42, y + 28.5, title, { "font-size": 13, "font-weight": 600, fill: C.ink }),
  );
}

/** Four panels: seal, commit, release, open and clear. Each is a <g data-step="n">. */
export function railArt(): SVGSVGElement {
  const r = svgRoot(
    572,
    440,
    "Four steps. Seal: the bid is encrypted under K and K's three shares are sealed with ML-KEM-1024. Commit: commitBid stores the ciphertext, the hashes and the envelopes and pulls escrow and bond. Release: members 1 and 2 sign with ML-DSA-87 and pqcVerify accepts; an outsider's signature is refused. Open and clear: demand of 60 at 2.50 and 70 at 1.50 meets 100 on offer at 1.50.",
    "rail-art",
  );
  r.prepend(defs());

  // 1. Seal, in the browser.
  const p1 = g({ "data-step": "1", class: "panel" }, panelFrame(0, "Seal, in your browser"));
  p1.append(
    card(24, 50, 104, 46, { fill: C.a50, stroke: C.a200 }),
    text(36, 70, "bid", { "font-size": 11 }),
    text(36, 87, "60 @ ≤ 2.50", { "font-size": 12, "font-weight": 600, fill: C.ink, "font-family": MONO }),
    flow("M128 73H160", { "marker-end": "url(#arrow)" }),
    card(164, 50, 100, 46),
    text(176, 70, "ciphertext", { "font-size": 11 }),
    text(176, 87, "bid ⊕ keccak(K)", { "font-size": 10.5, fill: C.ink, "font-family": MONO }),
    s("circle", { cx: 76, cy: 140, r: 17, fill: C.a600 }),
    text(76, 145, "K", { "text-anchor": "middle", "font-size": 14, "font-weight": 600, fill: "#fff" }),
    flow("M76 96V123"),
  );
  p1.append(flow("M93 140C100 140 100 128 112 128H230"));
  [130, 178, 226].forEach((x, i) => {
    p1.append(
      flow(`M${x + 2} 128V140`),
      s("rect", { x: x - 18, y: 140, width: 40, height: 28, rx: 6, fill: C.a50, stroke: C.a300, "stroke-width": 1.4 }),
      s("path", { d: `M${x - 17} ${141}L${x + 2} ${153}L${x + 21} ${141}`, fill: "none", stroke: C.a300, "stroke-width": 1.4 }),
      text(x + 2, 186, `s${i + 1}`, { "text-anchor": "middle", "font-size": 11, "font-family": MONO }),
    );
  });
  p1.append(text(24, 204, "each share sealed to one member · ML-KEM-1024", { "font-size": 11 }));

  // 2. Commit, on chain.
  const p2 = g({ "data-step": "2", class: "panel" }, panelFrame(1, "Commit, on chain"));
  const fields: [string, string][] = [
    ["ct", "the sealed bid"],
    ["H(K)", "checks the key later"],
    ["H(s1) H(s2) H(s3)", "checks every share"],
    ["3 × 1,752 B", "envelopes, in the event"],
    ["escrow + bond", "pulled now"],
  ];
  p2.append(card(308, 48, 240, 130, { fill: "#f9fafb" }), text(320, 66, "commitBid stores", { "font-size": 11 }));
  fields.forEach(([k, v], i) => {
    const y = 88 + i * 19;
    p2.append(text(320, y, k, { "font-size": 11.5, "font-family": MONO, fill: C.ink }), text(536, y, v, { "text-anchor": "end", "font-size": 11 }));
  });
  p2.append(lockGlyph(318, 197, C.a600), text(332, 202, "fixed at commit: no reveal step to skip", { "font-size": 11.5, fill: C.ink2 }));

  // 3. Release, after the close.
  const p3 = g({ "data-step": "3", class: "panel" }, panelFrame(2, "Release, after the close"));
  const mrow = (y: number, label: string, sig: string, ok: boolean | null) => {
    p3.append(
      card(24, y, 240, 32, ok === null ? { "stroke-dasharray": "4 4", stroke: C.soft } : ok ? {} : { stroke: "#fecaca", fill: C.redWeak }),
      text(36, y + 20, label, { "font-size": 12, "font-weight": 600, fill: ok === null ? C.muted : C.ink }),
      text(150, y + 20, sig, { "font-size": 11, "font-family": MONO, fill: ok === false ? C.red : C.muted }),
    );
    if (ok) p3.append(check(246, y + 16));
    if (ok === false) p3.append(s("path", { d: `M${242} ${y + 12}l8 8m0-8l-8 8`, stroke: C.red, "stroke-width": 1.8, "stroke-linecap": "round" }));
  };
  mrow(266, "Member 1", "ML-DSA-87", true);
  mrow(304, "Member 2", "ML-DSA-87", true);
  mrow(342, "Member 3", "offline", null);
  mrow(380, "Outsider", "forged", false);
  p3.append(text(24, 426, "pqcVerify checks each one; a forged release reverts", { "font-size": 11 }));

  // 4. Open and clear: the testnet demo's demand against the supply.
  const p4 = g({ "data-step": "4", class: "panel" }, panelFrame(3, "Open and clear"));
  const ox = 336;
  const oy = 396;
  const xw = 200; // 0..130 PEAL-T
  const yh = 116; // 0..3.00 fUSD
  const X = (q: number) => ox + (q / 130) * xw;
  const Y = (p: number) => oy - (p / 3) * yh;
  p4.append(
    s("path", { d: `M${ox} ${oy}H${ox + xw + 6}M${ox} ${oy}V${oy - yh - 6}`, stroke: C.line, "stroke-width": 1 }),
    // demand: 60 at 2.50, then 70 more at 1.50
    s("rect", { x: X(0), y: Y(2.5), width: X(60) - X(0) - 1, height: oy - Y(2.5), fill: C.a600, rx: 2 }),
    s("rect", { x: X(60) + 1, y: Y(1.5), width: X(100) - X(60) - 1, height: oy - Y(1.5), fill: C.a600, rx: 2 }),
    s("rect", { x: X(100) + 1, y: Y(1.5), width: X(130) - X(100) - 1, height: oy - Y(1.5), fill: C.a200, rx: 2 }),
    s("path", { d: `M${X(100)} ${oy}V${Y(2.9)}`, stroke: C.ink2, "stroke-width": 1.2, "stroke-dasharray": "3 3" }),
    text(X(100) + 4, Y(2.75), "100 on offer", { "font-size": 11, fill: C.ink2 }),
    s("path", { d: `M${ox} ${Y(1.5)}H${X(130)}`, stroke: C.ink, "stroke-width": 1.2 }),
    text(ox - 6, Y(1.5) + 4, "1.50", { "text-anchor": "end", "font-size": 11, "font-weight": 600, fill: C.ink }),
    text(ox - 6, Y(2.5) + 4, "2.50", { "text-anchor": "end", "font-size": 11 }),
    text(X(30), Y(2.5) - 6, "60", { "text-anchor": "middle", "font-size": 11, fill: C.ink2 }),
    text(X(80), Y(1.5) - 6, "40 of 70", { "text-anchor": "middle", "font-size": 11, fill: C.ink2 }),
    text(308, 422, "every winner pays 1.50 · the testnet run", { "font-size": 11 }),
  );
  r.append(p1, p2, p3, p4);
  return r;
}
