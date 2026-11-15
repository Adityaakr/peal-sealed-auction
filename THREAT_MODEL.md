# Threat model

Peal Sealed Auction: what is protected, against whom, and what is not. This file states the target design; sections marked *(planned)* describe code that lands in later pull requests.

## Assets

- **Bid contents** (quantity, highest price tick) before the close.
- **Escrow** (quote token) and the **sale supply** held by each auction.
- **Outcome integrity**: one clearing price and allocations that follow the published rule.

## Actors

| Actor | Holds | Trusted for |
|---|---|---|
| Bidder | its EVM key, its bid, K and the shares it dealt | nothing; it can deal junk |
| Committee member (n of them, threshold t) | ML-DSA-87 key, ML-KEM-1024 + X25519 key | at most t − 1 collude (confidentiality); at least t release (liveness) |
| Issuer | sale supply | nothing after `openCommit`; cannot read or change bids |
| Relayer / anyone | gas | nothing; every privileged message carries its own signature |
| REST proxy | nothing | nothing; its answers are checked against on-chain hashes |

## Properties

**Confidentiality before the close.** Reading a bid needs t of n members to pool shares, or breaking ML-KEM-1024 *and* X25519 for t members' envelopes, or breaking the 256-bit keccak keystream under K. Recorded ciphertexts stay safe against a future quantum computer under the ML-KEM assumption.

**Integrity.** The bid is fixed at commit (`ct`, `keyHash`, `shareHashes`). A share that does not match its hash is refused on chain, and a forged release fails `pqcVerify`. *(planned)*

**Liveness.** Any t honest members open every well-formed bid. Missing releases exclude bids, never the auction. With no releases at all, the timeout refunds everyone, bonds included. *(planned)*

**Clearing.** At most 256 ticks are scanned, so settlement cost does not grow with the number of bids. Escrow rounds up and payment rounds down, so one bidder's shortfall can never be taken from another's deposit. Allocation is independent of claim order. These hold in the code today and are fuzzed (`test/ClearingPrice.t.sol`, `test/AuctionMath.t.sol`).

## Design rules (from Peal's plan 017 review, credited)

1. Exclude, never fail: an unopenable bid is excluded and refunded; it never fails the auction.
2. One all-or-nothing signed release per member over the whole frozen set of bids, so withholding one bid is attributable.
3. Bind every seal to its context: chain id, auction, bidder, bid sequence, share index.
4. Release on chain state (after `closeCommit`), not on a clock.
5. Junk costs a deposit: a bid that still cannot open after all n releases forfeits its bond to a burn address.

## Residual risks, stated plainly

- t colluding members can read bids early, or withhold a chosen bid, which then loses its bond if the remaining member also released.
- A bidder colluding with one member gets a delayed decision on whether its bid opens. Stretch fix: commit-then-reveal releases.
- Escrow amounts are public and bound each bid's value from above. Bidders may over-escrow; the excess is refunded.
- In the demo all three committee keys are held by the project owner as three separate accounts (disclosed, demo only).
- QoreSeal 0.1.0 is a draft pending external review.
- The REST endpoint used to read ML-KEM keys is untrusted; keys are accepted only if their hash equals the member-signed hash in the registry.
