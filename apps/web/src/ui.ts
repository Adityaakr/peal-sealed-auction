/**
 * ui.ts - the small toolkit the pages are built from, in the shared Peal design
 * language (docs/design.md in Adityaakr/peal-tender). Adapted from Peal Tender's
 * apps/dashboard/src/ui.ts: the minimum copied, with this product's mark added.
 *
 * Every piece of text goes in through `textContent` (never innerHTML): addresses,
 * token symbols and auction names come from the chain, so they are data, not
 * markup. Icons are fixed inline SVG paths defined here.
 */

export type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

/** Build an element: h("div.card.stat", { title: "x" }, child, ...). */
export function h(tag: string, attrs?: Attrs | Child, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs && !(attrs instanceof Node) && typeof attrs === "object") {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
      else if (k === "class") el.className += ` ${v}`;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  } else if (attrs !== undefined) {
    children.unshift(attrs as Child);
  }
  for (const c of children) append(el, c);
  return el;
}

export function append(el: Element, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  el.append(c instanceof Node ? c : document.createTextNode(String(c)));
}

const NS = "http://www.w3.org/2000/svg";

/** Build an SVG element. Text, when given, goes in as textContent. */
export function s(tag: string, a: Record<string, string | number> = {}, ...kids: (SVGElement | string)[]): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

// ---------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  check: "M3 8.5l3 3 7-7",
  cross: "M4 4l8 8M12 4l-8 8",
  clock: "M8 4v4l2.5 2M8 15A7 7 0 108 1a7 7 0 000 14z",
  dot: "M8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z",
  arrow: "M3 8h10M9 4l4 4-4 4",
  out: "M6 3H3v10h10v-3M9 3h4v4M13 3L7 9",
  key: "M10 6a3 3 0 11-6 0 3 3 0 016 0zM9 8l5 5M12 11l1.5-1.5",
  lock: "M4.5 7V5a3.5 3.5 0 017 0v2M3.5 7h9v7h-9z",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  seal: "M2.5 8h11M5.5 5h5v6h-5z",
  github: "M6 13.5c-3 1-3-1.5-4.5-2M10 15v-2.5c0-.8.1-1.3-.4-1.8 2-.2 4-1 4-4.5a3.5 3.5 0 00-1-2.5 3.2 3.2 0 00-.1-2.4s-.8-.3-2.5 1a8.5 8.5 0 00-4.5 0C3.8 1 3 1.3 3 1.3a3.2 3.2 0 00-.1 2.4 3.5 3.5 0 00-1 2.5c0 3.5 2 4.3 4 4.5-.5.5-.5 1-.4 1.8V15",
  copy: "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
  wallet: "M2.5 4.5h10a1 1 0 011 1v7a1 1 0 01-1 1h-10zM2.5 4.5l8-2v2M11 9h.01",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
};

export function icon(name: keyof typeof PATHS | string): SVGSVGElement {
  const svg = s("svg", {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.6,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }) as SVGSVGElement;
  svg.append(s("path", { d: PATHS[name] ?? PATHS.dot! }));
  return svg;
}

// ---------------------------------------------------------------- the Peal family marks

export type Product = "peal" | "tender" | "auction" | "bidder";

/**
 * The Peal family marks, used as drawn: the masters come from docs/brand/ in
 * Adityaakr/peal-tender (copied unaltered into public/brand/). Each sits beside
 * its name, so the image is decorative. `ground` picks the version drawn for a
 * light or a dark background.
 */
export function mark(product: Product = "auction", cls = "mark", ground: "light" | "dark" = "light"): HTMLImageElement {
  const img = document.createElement("img");
  img.src = `/brand/${product}/${ground === "dark" ? "mark-dark" : "mark"}.svg`;
  img.alt = "";
  img.className = cls;
  img.width = 24;
  img.height = 24;
  img.decoding = "async";
  return img;
}

export const FAMILY: { id: Product; name: string; role: string; line: string; href: string }[] = [
  { id: "tender", name: "Peal Tender", role: "the treasury", line: "A treasury held by post-quantum signatures, with sealed buybacks.", href: "https://github.com/Adityaakr/peal-tender" },
  { id: "auction", name: "Peal Sealed Auction", role: "the venue", line: "Sealed bids no single key holder can open before the close.", href: "https://github.com/Adityaakr/peal-sealed-auction" },
  { id: "bidder", name: "Peal Bidder", role: "the participant", line: "An agent that bids for you, only inside mandates you signed.", href: "https://github.com/Adityaakr/peal-bidder" },
];

// ---------------------------------------------------------------- pieces

export type Tone = "ok" | "bad" | "wait" | "warn" | "plain";

/** A status chip: always an icon and a word, never colour alone. */
export function chip(text: string, tone: Tone = "plain", iconName?: string): HTMLElement {
  const fallback = { ok: "check", bad: "cross", wait: "clock", warn: "pause", plain: "dot" }[tone];
  return h(`span.chip${tone === "plain" ? "" : `.${tone}`}`, icon(iconName ?? fallback), text);
}

/** A copyable hash or address, shortened for display, full on hover and when copied. */
export function hash(value: string, opts: { full?: boolean; label?: string } = {}): HTMLElement {
  const shown = opts.full || value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
  const b = h("button.hash", { type: "button", title: `${value} (click to copy)`, "aria-label": `copy ${opts.label ?? value}` }, shown);
  b.addEventListener("click", () => {
    void navigator.clipboard?.writeText(value).then(() => {
      b.classList.add("copied");
      setTimeout(() => b.classList.remove("copied"), 1200);
    });
  });
  return b;
}

/** A token amount with grouping and at most `max` fraction digits, trailing zeros dropped. */
export function amount(v: bigint, decimals: number, max = 4): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const int = (a / base).toLocaleString("en-US");
  const frac = decimals ? (a % base).toString().padStart(decimals, "0").slice(0, max).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${frac ? `${int}.${frac}` : int}`;
}

/** A price with exactly two decimals (rounded down), e.g. 1.50. */
export function price2(v: bigint, decimals: number): string {
  const [i, f = ""] = amount(v, decimals, 2).split(".");
  return `${i}.${f.padEnd(2, "0")}`;
}

export function duration(seconds: bigint | number): string {
  let t = Math.max(0, Math.round(Number(seconds)));
  const d = Math.floor(t / 86400);
  t -= d * 86400;
  const hr = Math.floor(t / 3600);
  t -= hr * 3600;
  const m = Math.floor(t / 60);
  t -= m * 60;
  if (d) return hr ? `${d}d ${hr}h` : `${d}d`;
  if (hr) return m ? `${hr}h ${m}m` : `${hr}h`;
  if (m) return t ? `${m}m ${t}s` : `${m}m`;
  return `${t}s`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
