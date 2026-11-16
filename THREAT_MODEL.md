# Threat model

What Peal Sealed Auction protects, against whom, and what it does not. Every defence below is in the deployed contracts and has a test. The tests run on the kit's precompile mocks, or against the live testnet where noted.

## Assets

- **Bid contents** (quantity, highest price tick) until the close.
- **Escrow** (quote token) and the **sale supply** each auction holds.
- **Outcome integrity**: one clearing price and allocations that follow the published rule.

## Actors and what each is trusted for

| Actor | Holds | Trusted for |
|---|---|---|
| Bidder | its EVM key, its bid, K and the shares it dealt | nothing; it may deal junk |
| Committee member (n of them, threshold t; 2 of 3 deployed) | ML-DSA-87 key, ML-KEM-1024 + X25519 key | at most t − 1 collude (confidentiality); at least t release (liveness) |
| Issuer | the sale supply | nothing after `openCommit`; cannot read or change bids |
| Relayer, keeper, anyone | gas | nothing; every privileged message carries its own signature, and every other step is permissionless |
| REST proxy | nothing | nothing; its answers are checked against hashes the key owners signed on chain |

## Attacks and what stops them

| Attack | What stops it | Evidence |
|---|---|---|
| Read a bid before the close | K is split t-of-n and each share is sealed to a different member's ML-KEM-1024 + X25519 key; fewer than t shares give no information about K | `test-ts`: one share does not give the key; an outsider opens nothing |
| One member reads bids early | A share alone is a uniformly random field element | same; the committee page shows a member only its own shares |
| Store ciphertexts now, decrypt with a quantum computer later | The shares are under ML-KEM-1024 (hybrid with X25519); the bid is under a 256-bit keccak keystream of K. Both stay sound against known quantum attacks (Grover leaves 128-bit security) | design |
| A REST proxy substitutes a member's ML-KEM key | Bidders accept a key only if its SHA3-256 equals the hash the member signed into the registry with ML-DSA-87; the card must match its hash and verify against both keys | `e2e-local`: a lying proxy is caught; `CommitteeRegistry` join tests |
| Register a committee member who did not consent | Each join is an ML-DSA-87 signature by that account's registered key (with proven possession), checked by `pqcVerify` and bound to the exact set | 16 registry tests; testnet `registerSet` `0x470ce18a…b593` |
| Forge a release | `pqcVerify` against the member's key from `pqcKeyStatus`; the signed message binds chain id, auction, member, the bid count, every share and the invalid bitmap | `test_releaseSignedByNonMemberRefused`, `…AnotherMember…`, `…ForAnotherAuction…`; testnet: forged release refused by the live `pqcVerify` |
| Replay a release, or release twice | One release per member; the signature binds this auction | `test_releaseReplayRefused` |
| Post a wrong share to block or change a bid | Every share is checked against the bidder's committed hash; one wrong share reverts the whole release | `test_releaseWithWrongShareRevertsWhole`, `…AnotherMembersShare…` |
| Post a share outside the field to make recombination revert for everyone | Refused at release time | `test_releaseRefusesShareOutsideField` |
| Change a bid after commit (bidder or committee) | `ct`, `keyHash` and the share hashes are fixed at commit; a rebuilt K is accepted only if it matches `keyHash` | `test_bidsOpenToTheCommittedValues`; invariant `noBidOpensBelowThreshold` |
| Release before bidding closes | Releases are accepted only in state `Closed` (on chain, not a clock); members' software waits for it | `test_releaseBeforeCloseRefused`; `e2e-local`: a member waits while bidding is open |
| Finalize early to drop openable bids | `finalize` is refused while a release can still arrive or any bid is undecided | `test_earlyFinalizeWithOpenableBidsRefused`, `e2e-local` |
| A junk bid (bad shares, bad plaintext) blocks the auction | Excluded and refunded; never fatal. Bonds burn only when the fault is clear (see rule 5) | `test_inconsistentDealerIsExcludedNotFatal`, `test_malformedPlaintextBurnsBond`, `e2e-local` |
| A member stays offline | Any t members open every bid | testnet demo: member 3 offline, both bids opened |
| Nobody finalizes | After the release deadline plus 3 days anyone may fail the auction and refund everyone | `test_failOnTimeout` |
| Inactive precompile (empty return) read as "valid" | `PqAuth` fails closed | `test_releaseFailsClosedOnEmptyPrecompile`, `test_failsClosedOnEmptyPrecompile` |
| Insolvency through rounding | Escrow rounds up, payment rounds down, and proceeds are the exact sum of what winners pay | fuzz: every auction ends with both balances at exactly zero; invariants `quoteSolvent`, `saleSolvent` |
| Fee-on-transfer token shortchanges the auction | Balance-delta checks on funding and on every commit | `test_feeOnTransferQuoteRefused` |
| Stolen classical (secp256k1) key | QoreChain admits EVM transactions only inside a window opened by a hybrid ML-DSA-87 signature. The scripts scope every window to the contracts an account needs and to an exact transaction count | testnet demo (scoped windows, spent windows inert) |

## Design rules (from Peal's plan 017 review, credited)

1. **Exclude, never fail.** An unopenable bid is excluded and refunded; it never fails the auction.
2. **One release per member, all or nothing.** Each member signs one release over the whole frozen set of bids, so withholding one bid is attributable.
3. **Bind every seal to its context:** chain id, auction, bidder, bid sequence, share index.
4. **Release on chain state** (after `closeCommit`), not on a clock.
5. **Junk costs a deposit.** The bond goes to a burn address:
   - when a bid opens to a malformed plaintext, which only the bidder can cause, because K is checked against `keyHash`;
   - or when all n members released and the bid still cannot open.

   A bid that fails only because members stayed away keeps its bond.

## What is post-quantum, and what is not

- **Post-quantum:**
  - share encryption (ML-KEM-1024, hybrid with X25519);
  - committee joins and releases (ML-DSA-87 through `pqcVerify`);
  - every QoreChain native transaction (hybrid secp256k1 + ML-DSA-87), including the windows that admit EVM transactions;
  - Shamir sharing, which is information-theoretic;
  - the keccak-based cipher and commitments.
- **Classical:**
  - the EVM transaction signature itself (secp256k1). It is bounded by the ML-DSA-signed window that admits it.
  - X25519 inside the hybrid envelope. A break of X25519 alone does not open an envelope.

## Residual risks, stated plainly

- **t colluding members can read bids early,** or withhold a chosen bid. If the remaining member also released, that bid then loses its bond.
- **A bidder colluding with one member gets a delayed decision** on whether its bid opens. A bidder can deal shares where only some pairs rebuild K, so whether the bid opens depends on which members release. The plaintext cannot change: any matching pair gives the committed K. Stretch fix: commit-then-reveal releases.
- **Escrow amounts are public** and bound each bid's value from above. Bidders may over-escrow; the excess is refunded.
- **One person holds all committee keys in the demo.** The project owner holds all three, as three separate accounts. This is disclosed and for the demo only.
- **QoreSeal 0.1.0 is a draft** pending external review.
- **The web pages' dev-account mode** takes a testnet mnemonic in the page. The page never stores or sends it, but a compromised page or browser could read it. It is for throwaway testnet accounts in the demo only: no real funds, no public bidding.
- **The local stand-ins accept anyone's verdict.** `OraclePqcVerify` and the `/local/attest` endpoint let anyone record a signature verdict. They exist only for local runs, are never deployed, and their source says so.
- **The REST endpoint and the proxy are untrusted** by design. Keys from them are accepted only against member-signed hashes. Envelopes recovered from REST (smart-account bids) and cards from `deployments/committee-cards.json` are untrusted too: a wrong envelope opens to a share that fails its on-chain hash, and a wrong card fails its member-signed hash.
- **The contracts have not had an external audit.**
