# Peal Sealed Auction: design

Peal Sealed Auction's landing page has its own identity: **the sealed envelope**.
The shared Peal family rules (wordmark, family line in the footer, voice, evidence,
accessibility, wallets) are in [Peal Tender's `docs/design.md`](https://github.com/Adityaakr/peal-tender/blob/main/docs/design.md);
this file holds only what is this product's own.

## Concept

- **The visitor:** a builder or a fest judge who knows sealed-bid and commit-reveal
  auctions, and doubts claims about "encrypted bids".
- **The idea in five seconds:** every bid stays sealed until two of three committee
  keys meet after the close, and then everyone clears at one price.
- **The metaphor:** the sealed slot. Bids are drawn as slots that carry their real
  ciphertext; three brass keys sit under them; the page builds to the moment the slots
  open and the clearing price lands.

## Order of the page

Each section answers one question a visitor has, and each diagram answers it visually:

| Section | The question | The drawing |
| --- | --- | --- |
| Hero, the vault | What is this, and is it live? | The open demo auction's slots, with each sealed bid's real ciphertext |
| 01 The problem | Why not encrypt to one auction key? | One key and its holder, against a split key per bid |
| 02 How a bid is sealed | What exactly goes on chain? | The 32-byte plaintext, ct, K and its shares, `commitBid`'s fields with sizes, the three envelopes |
| 03 When a bid can be read | Who can read my bid, and when? | The phases on a time line, and a matrix of readers per phase, with the trust assumption |
| 04 Why no one opens it early | What does the chain check, and what is refused? | Releases through `pqcVerify` to K and `openBids`; the committee and the refusals as tables |
| 05 Live proof: the reveal | Did it actually work? | The testnet run's two ciphertexts opened, the demand against the supply, the price, every transaction |
| 06 Requirements | Does it meet the category? | A table, each row with a transaction or a test |
| 07 Try it | Can I do it myself? | A checklist with live state and real buttons |

## Palette

One dark world, chosen on purpose (the page does not switch themes).

| Token | Value | Use |
| --- | --- | --- |
| night | `#0e1016` | the ground |
| vault | `#151821` | boxes in diagrams, the vault, cards |
| rule / line | `#242833` / `#3b404d` | hairlines / diagram strokes |
| paper / paper-2 / muted | `#ece8df` / `#b8b4aa` / `#858891` | text, secondary text, labels |
| **brass** | `#d4a95b` (dim at 30%, weak at 8%) | the one accent: seals, keys, the signed path, the clearing price |
| ok / bad | `#7fd19b` / `#f2867a` | accepted / refused only, always with a word |

## Type

- **Display:** Martian Mono 400 at width 87.5, tracked tight: headlines read like cipher
  text you can read. Hero 46px (34 on a phone), section titles 34px (25).
- **Text:** Geist 400, 500, 600; leads 17 to 18px, body 16px.
- **Data:** Geist Mono for hashes, sizes, figures and labels.
- One emphasised phrase per headline, in brass.

## Diagrams

- Ink-on-night schematics: vault boxes with a hairline, 6px corners, 1.25px connectors
  with filled arrowheads; brass for what is sealed, keyed or signed; red for a refusal;
  green for an accepted check.
- Real names and real sizes only (`commitBid`, `pqcVerify`, 1,752 B, 32 B).
- Every diagram has a separate phone drawing below 820px; none is the desktop one shrunk.
- `role="img"` with an `aria-label` that says what the picture shows.

## Motion

One moment: the reveal. With motion allowed and the section not yet in view, the two
envelopes show sealed (ciphertext, price blurred, chart empty); when it enters the view
they open once (600 to 700 ms). "Seal them again" replays it. With reduced motion the
section is simply open. Nothing loops.
