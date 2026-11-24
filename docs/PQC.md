# Where the post-quantum checks are, and what each one protects

The fest's checker cannot mark the Solidity PQC features (*Solidity PQC signature check*, *Solidity PQC key status*) as verified, so jurors check them by hand ([FAQ](https://build.qorechain.io/faq)). This page gives every call site, what it protects, the test that covers it, and a testnet transaction where it ran on the real precompile.

Foundry tests run on `qore-pq-kit`'s precompile mocks. `npm run e2e:local` uses real ML-DSA-87 signatures, checked off chain by the harness (`test/mocks/OraclePqcVerify.sol`, local only). The testnet transactions below ran on the real precompiles.

## On chain: `pqcVerify` (`0x…0a01`) and `pqcKeyStatus` (`0x…0a02`)

Both contracts go through one small library, `lib/qore-pq-kit/src/PqAuth.sol`:

- `PqAuth.keyOf(account)` calls `pqcKeyStatus`. It returns the key only if the key is registered, is ML-DSA-87, has a proven possession and is 2,592 bytes long. Otherwise it reverts with `PqKeyUnusable`.
- `PqAuth.verify(key, sig, msg)` calls `pqcVerify` and accepts only an exact `1`. An empty answer, which is what an inactive precompile returns, reverts with `PqPrecompileUnavailable` and is never read as a verdict.
- `PqAuth.message(...)` is the exact 256 bytes that get signed: domain, `block.chainid`, the verifying contract, the signer, the action, nonce, deadline and an args hash.

| Call site | What it protects | Tests | On the testnet |
|---|---|---|---|
| `src/CommitteeRegistry.sol:132`, `_join`: `PqAuth.verify(PqAuth.keyOf(m.account), j.signature, signed)` | **Nobody is put on a committee without consenting, and nobody's encryption key is swapped.** Each member signs, with its own registered ML-DSA-87 key, the set id, its index, the SHA3-256 of its ML-KEM-1024 key and the hash of its QoreSeal card. Bidders later accept a member's ML-KEM key only if it matches that signed hash. | `test/CommitteeRegistry.t.sol`: `test_rejectsJoinSignedByAnotherKey`, `test_rejectsMemberWithoutPqKey`, `test_joinBindsTheKemKeyHash`, `test_joinBindsTheCard`, `test_joinForOneSetCannotJoinAnother`, `test_rejectsExpiredJoins`, `test_failsClosedOnEmptyPrecompile` | `registerSet` `0x470ce18a…b593`: three joins checked by the live `pqcVerify` |
| `src/SealedAuction.sol:406`, `_verifyRelease`: `PqAuth.verify(PqAuth.keyOf(member), signature, signed)` | **Only a committee member can release, and only for this auction's frozen bid set.** The signed args hash covers the bid count, every share and the invalid bitmap. The contract also checks every share against the hash the bidder committed, so a valid signature over a wrong share still reverts. | `test/SealedAuction.t.sol`: `test_releaseSignedByNonMemberRefused`, `test_releaseSignedByAnotherMemberRefused`, `test_releaseForAnotherAuctionRefused`, `test_releaseReplayRefused`, `test_expiredReleaseSignatureRefused`, `test_releaseFailsClosedOnEmptyPrecompile`, `test_releaseWithWrongShareRevertsWhole`, `test_releaseMessageMatchesPqAuthFormat` | releases `0xc999a0c2…ee68`, `0xcc039c7d…3007` (16 Nov run); `0x41be4981…a856`, `0x9be17517…129c`, `0xec0d4b52…7855` (first open demo, settled 23 Nov). An outsider's forged release was refused by the live `pqcVerify` with `ReleaseSignatureInvalid` |
| `src/demo/PealBond.sol`, through the Asset Kit's `QoreChainHybridHolderGuard` (unchanged, `lib/qorechain-asset-kit`) | **A bond allocation lands only where a stolen classical key alone cannot move it.** The guard reads `pqcKeyStatus` and fails closed. | `test/PealBond.t.sol`: `test_keyWithoutPossessionOrOtherAlgorithmIsRefused`, `test_failsClosedWhenThePrecompileAnswersNothing`, `test_issuerMustHoldAKeyToMint` | payouts `0x4a796ff9…75fd`, `0x1c216b6b…e7a1`; a transfer to a keyless address reverts `NotEligible` |

Full hashes: `deployments/qorechain-diana.json`, `deployments/demo-0x9CbA…c124.json`, `deployments/open-demo-0x9A98…c7B4.json`, `deployments/bond-demo.json`. `npm run evidence` re-checks every one of them through the `qore` CLI.

## In the browser and the member's daemon: ML-KEM-1024 and ML-DSA-87

| Where | Primitive | What it protects | Tests |
|---|---|---|---|
| `client/committee.ts` (kit `verifyMember`), before any bid is sealed | ML-DSA-87 key from `pqcKeyStatus`; ML-KEM-1024 key from `/qorechain/pqc/v1/kem/{addr}`, accepted only if its SHA3-256 equals the hash the member signed on chain; the QoreSeal card checked against the hash the member signed on chain and against both keys. A card that ships with the page is used only if its hash matches the registry's | A lying REST endpoint or proxy cannot slip in its own encryption key | `npm run e2e:local`: a REST proxy that swaps member 2's key is caught, and a wrong bundled card is refused; `test-ts/committee.test.ts`: tampered, swapped, outsider-signed, malformed and self-consistent but false cards are all refused |
| `client/bid.ts:41` (kit `sealSlot`) | QoreSeal hybrid envelope, ML-KEM-1024 + X25519, one 1,752-byte envelope per member; AAD binds chain id, auction, bidder and the bidder's own counter | **The bid's key K is split 2 of 3 and each share is sealed to a different member**, so no single share holder, the issuer included, can read a bid. That assumes fewer than two members collude and that the keys are held independently; in the demo one owner holds all three. A recorded envelope stays closed to a future quantum attacker | `test-ts/client.test.ts`: an outsider opens nothing; an envelope copied to another bidder or counter fails its AAD; one share does not give the key |
| `client/release.ts:198` (`signRelease`), from `apps/committee/` or the committee page | ML-DSA-87 signature over `releaseMessage(...)`, read from the contract | The member's release, which `SealedAuction` checks above | `test-ts/`; `e2e-local` |
| `client/audit.ts:89` (`mldsa87.verify` from `@qorechain/pqc`), the results page's *Check it in this browser* and `npm run testnet -- audit` | ML-DSA-87 verification off chain, against the key the chain registered, over a message the page rebuilds itself | **Anyone can check an auction without trusting the contract's own verdicts.** The page also reopens every bid from the stored shares | `test-ts/audit.test.ts`; on the testnet both settled auctions pass (`0x9CbA…c124`, `0x9A98…c7B4`) |

## Why post-quantum matters for a sealed bid

- **The confidential window is real.** Bids must stay unreadable while bidding is open, which in the demo is weeks. Envelopes are public on chain from the moment of `commitBid`, so anyone can copy them. With classical-only encryption, an attacker with a quantum computer could open them later, and an auction that is still open, or a bid that never opens (excluded, or the committee stayed away), would leak. ML-KEM-1024 keeps them closed.
- **Releases and joins decide who can open bids.** If a classical signature were enough, an attacker who recovers a member's ECDSA key could join committees in that member's name or forge releases. Both are ML-DSA-87 checked on chain, so a stolen classical key alone does neither.
- **Every account action is hybrid.** EVM transactions on QoreChain run only inside a window opened by a hybrid ML-DSA-87 signature, and the scripts and the guest account scope each window to the contracts they call and an exact number of transactions.

What is not post-quantum, and why that is bounded: [`THREAT_MODEL.md`](../THREAT_MODEL.md#what-is-post-quantum-and-what-is-not).
