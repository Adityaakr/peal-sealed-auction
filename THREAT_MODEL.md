# Threat model

Peal Sealed Auction: what is protected, against whom, and what is not. This file states the design; the contract properties below are implemented and tested on mocked precompiles, and the off-chain apps land in later pull requests.

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

**Integrity.** The bid is fixed at commit (`ct`, `keyHash`, `shareHashes`). A share that does not match its hash, or that is not a field element, reverts the whole release on chain. A release signed by anyone but the member, or for another auction or another bid count, fails `pqcVerify`. Releases are accepted only after `closeCommit` and before `releaseDeadline`, once per member. A key rebuilt from shares is accepted only if it matches the bidder's `keyHash`, so no committee can change a plaintext.

**Liveness.** Any t honest members open every well-formed bid. Missing releases exclude bids, never the auction. With no releases at all, every bid is unopenable, the auction fails and everyone is refunded, bonds included. If nobody finalizes within 3 days after the release deadline, anyone can fail the auction (refunds for all).

**Early finalize.** `finalize` is refused while any release can still arrive or any bid is undecided, so nobody can finalize early to drop openable bids. The fail-closed precompile handling comes from `PqAuth`: an inactive precompile (empty return data) reverts rather than reading as a verdict.

**Solvency.** Proceeds are the exact sum of what winners pay, so the quote balance covers every refund plus the proceeds; this is checked by an invariant test (random actors) and a fuzz test that ends every auction at exactly zero balances.

**Clearing.** At most 256 ticks are scanned, so settlement cost does not grow with the number of bids. Escrow rounds up and payment rounds down, so one bidder's shortfall can never be taken from another's deposit. Allocation is independent of claim order. These hold in the code today and are fuzzed (`test/ClearingPrice.t.sol`, `test/AuctionMath.t.sol`).

## Design rules (from Peal's plan 017 review, credited)

1. Exclude, never fail: an unopenable bid is excluded and refunded; it never fails the auction.
2. One all-or-nothing signed release per member over the whole frozen set of bids, so withholding one bid is attributable.
3. Bind every seal to its context: chain id, auction, bidder, bid sequence, share index.
4. Release on chain state (after `closeCommit`), not on a clock.
5. Junk costs a deposit: the bond goes to a burn address when a bid opens to a malformed plaintext (only the bidder can cause that, because K is checked against `keyHash`), or when all n members released and the bid still cannot open. A bid that fails only because members stayed away keeps its bond.

## Residual risks, stated plainly

- A bidder can deal shares where only some pairs rebuild K. Whether its bid opens then depends on which members release. Any matching pair gives the committed K, so the plaintext cannot change.
- t colluding members can read bids early, or withhold a chosen bid, which then loses its bond if the remaining member also released.
- A bidder colluding with one member gets a delayed decision on whether its bid opens. Stretch fix: commit-then-reveal releases.
- Escrow amounts are public and bound each bid's value from above. Bidders may over-escrow; the excess is refunded.
- In the demo all three committee keys are held by the project owner as three separate accounts (disclosed, demo only).
- QoreSeal 0.1.0 is a draft pending external review.
- The web pages' dev-account mode takes a testnet mnemonic in the page. It never stores or sends it, but a compromised page or browser could read it. It is for the demo with throwaway testnet accounts only; no real funds and no public bidding (D8).
- The local stack's `OraclePqcVerify` and its `/local/attest` endpoint let anyone record a signature verdict. They exist only for local runs, are never deployed, and their source says so.
- The REST endpoint used to read ML-KEM keys is untrusted; keys are accepted only if their hash equals the member-signed hash in the registry.
